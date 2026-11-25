use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, State,
    },
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use axum::middleware;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, watch, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct HotkeyConfig {
    import: String,
    replace: String,
    sync: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            import: "CommandOrControl+Shift+I".to_string(),
            replace: "CommandOrControl+Shift+R".to_string(),
            sync: "CommandOrControl+Shift+S".to_string(),
        }
    }
}

#[derive(Clone)]
struct AppState {
    // pairing_id -> broadcast sender for local relay: (sender_connection_id, json_payload)
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<(u64, String)>>>>,
    // Monotonic connection ID generator (prevents self-echo on broadcast)
    next_conn_id: Arc<AtomicU64>,
    // Live active WebSocket connection counter
    active_connections: Arc<Mutex<usize>>,
    sources_count: Arc<Mutex<usize>>,
    targets_count: Arc<Mutex<usize>>,
    // Whether the local WebSocket broker is accepting connections
    broker_enabled: Arc<Mutex<bool>>,
    // Watch sender to disconnect active WS clients immediately on pause
    enabled_tx: Arc<watch::Sender<bool>>,
    // Currently bound local TCP port
    broker_port: Arc<Mutex<u16>>,
    // Watch sender to trigger dynamic port rebinding
    port_tx: Arc<watch::Sender<u16>>,
    // Configurable global hotkeys
    hotkeys: Arc<Mutex<HotkeyConfig>>,
    // Live service connections (figma = local Figma companion connected; miro = linked)
    service_connections: Arc<Mutex<HashMap<String, bool>>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
}

impl AppState {
    async fn emit_status(&self, status: &str, sessions: usize, message: Option<String>) {
        let sources = *self.sources_count.lock().await;
        let targets = *self.targets_count.lock().await;
        let port = *self.broker_port.lock().await;
        if let Some(handle) = self.app_handle.lock().await.as_ref() {
            let _ = handle.emit("bridge_status", serde_json::json!({
                "status": status,
                "sessions": sessions,
                "sources": sources,
                "targets": targets,
                "port": port,
                "message": message,
            }));
        }
    }

    async fn log(&self, service: &str, message: impl Into<String>) {
        let msg: String = message.into();
        let sessions = *self.active_connections.lock().await;
        let enabled = *self.broker_enabled.lock().await;
        let status = if enabled { "active" } else { "paused" };
        self.emit_status(status, sessions, Some(format!("[{}] {}", service, msg))).await;
    }

    async fn set_service_connection(&self, service: &str, connected: bool) {
        self.service_connections.lock().await.insert(service.to_string(), connected);
    }

    async fn is_service_connected(&self, service: &str) -> bool {
        *self.service_connections.lock().await.get(service).unwrap_or(&false)
    }

    async fn get_or_create_channel(&self, pairing_id: &str) -> broadcast::Sender<(u64, String)> {
        let mut channels = self.channels.lock().await;
        if let Some(sender) = channels.get(pairing_id) {
            sender.clone()
        } else {
            let (sender, _) = broadcast::channel(128);
            channels.insert(pairing_id.to_string(), sender.clone());
            sender
        }
    }

    async fn prune_channel_if_empty(&self, pairing_id: &str) {
        let mut channels = self.channels.lock().await;
        if let Some(sender) = channels.get(pairing_id) {
            if sender.receiver_count() == 0 {
                channels.remove(pairing_id);
            }
        }
    }

    async fn broadcast_hotkey(&self, action: &str, shortcut_label: &str) {
        if !*self.broker_enabled.lock().await {
            return;
        }
        let payload = serde_json::json!({
            "action": "broadcast",
            "event": "hotkey",
            "payload": {
                "action": action,
                "shortcut": shortcut_label,
                "ts": Date_now_secs(),
            }
        })
        .to_string();

        let senders: Vec<broadcast::Sender<(u64, String)>> = {
            let channels = self.channels.lock().await;
            channels.values().cloned().collect()
        };

        for sender in &senders {
            // conn_id = 0 denotes server-originated broadcast (delivered to all subscribers)
            let _ = sender.send((0, payload.clone()));
        }

        self.log(
            "Hotkey",
            format!("Triggered '{}' ({}) -> {} channel(s)", action, shortcut_label, senders.len()),
        )
        .await;
    }
}

fn hotkeys_config_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("hotkeys.json"))
}

fn load_hotkeys_from_disk(app: &tauri::AppHandle) -> HotkeyConfig {
    if let Some(path) = hotkeys_config_path(app) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<HotkeyConfig>(&content) {
                return cfg;
            }
        }
    }
    HotkeyConfig::default()
}

fn save_hotkeys_to_disk(app: &tauri::AppHandle, cfg: &HotkeyConfig) {
    if let Some(path) = hotkeys_config_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(cfg) {
            let _ = std::fs::write(&path, json);
        }
    }
}

fn register_hotkeys(app: &tauri::AppHandle, state: AppState, cfg: &HotkeyConfig) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let entries: [(&str, &str); 3] = [
        ("import", cfg.import.trim()),
        ("replace", cfg.replace.trim()),
        ("sync", cfg.sync.trim()),
    ];

    // Validate all non-empty shortcuts first so partial registration doesn't leave inconsistent state
    let mut parsed: Vec<(&'static str, String, Shortcut)> = Vec::new();
    for (action_name, raw) in entries {
        if raw.is_empty() {
            continue;
        }
        let sc: Shortcut = raw
            .parse()
            .map_err(|e| format!("Invalid shortcut '{}' for {}: {:?}", raw, action_name, e))?;
        let action_static: &'static str = match action_name {
            "import" => "import",
            "replace" => "replace",
            _ => "sync",
        };
        parsed.push((action_static, raw.to_string(), sc));
    }

    for (action_static, label, sc) in parsed {
        let state_cb = state.clone();
        gs.on_shortcut(sc, move |_app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let st = state_cb.clone();
                let lbl = label.clone();
                tauri::async_runtime::spawn(async move {
                    st.broadcast_hotkey(action_static, &lbl).await;
                });
            }
        })
        .map_err(|e| format!("Failed to register shortcut for {}: {}", action_static, e))?;
    }

    Ok(())
}

#[derive(Deserialize, Serialize, Debug)]
struct WsPayload {
    #[serde(default)]
    action: String,
    #[serde(default)]
    pairing_id: Option<String>,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    payload: Option<serde_json::Value>,
    #[serde(default)]
    request_id: Option<String>,
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (port_tx, port_rx) = watch::channel(4401u16);
    let (enabled_tx, _enabled_rx) = watch::channel(true);
    let state = AppState {
        channels: Arc::new(Mutex::new(HashMap::new())),
        next_conn_id: Arc::new(AtomicU64::new(1)),
        active_connections: Arc::new(Mutex::new(0)),
        sources_count: Arc::new(Mutex::new(0)),
        targets_count: Arc::new(Mutex::new(0)),
        broker_enabled: Arc::new(Mutex::new(true)),
        enabled_tx: Arc::new(enabled_tx),
        broker_port: Arc::new(Mutex::new(4401)),
        port_tx: Arc::new(port_tx),
        hotkeys: Arc::new(Mutex::new(HotkeyConfig::default())),
        service_connections: Arc::new(Mutex::new(HashMap::new())),
        app_handle: Arc::new(Mutex::new(None)),
    };

    let state_clone = state.clone();
    tauri::async_runtime::spawn(async move {
        start_local_server(state_clone, port_rx).await;
    });

    tauri::Builder::default()
        .manage(state.clone())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_bridge_status,
            set_broker_enabled,
            set_broker_port,
            get_hotkeys,
            set_hotkeys
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let app_handle_clone = state.app_handle.clone();
            let loaded_hotkeys = load_hotkeys_from_disk(&handle);
            let hotkeys_state = state.clone();
            let hotkeys_for_setup = loaded_hotkeys.clone();
            if let Err(err) = register_hotkeys(&handle, hotkeys_state.clone(), &hotkeys_for_setup) {
                eprintln!("Global shortcut registration warning: {}", err);
            }
            tauri::async_runtime::spawn(async move {
                *hotkeys_state.hotkeys.lock().await = loaded_hotkeys;
                *app_handle_clone.lock().await = Some(handle.clone());
                handle.emit("bridge_status", serde_json::json!({
                    "status": "starting",
                    "sessions": 0,
                    "message": "[Bridge] Starting local WebSocket broker on ws://127.0.0.1:4401\u{2026}",
                })).ok();
            });

            let quit_i = MenuItem::with_id(app, "quit", "Quit SyncingBridge", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id.as_ref() {
                        "quit" => app.exit(0),
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button, .. } = event {
                        if button == tauri::tray::MouseButton::Left {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Validates whether an incoming browser Origin header is permitted to access the local broker.
fn is_allowed_origin(origin: &str) -> bool {
    if origin.is_empty() || origin == "null" {
        // Empty = non-browser/server-side local proxy; "null" = Figma/Penpot sandboxed plugin iframe
        return true;
    }

    let (is_https, rest) = if let Some(r) = origin.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = origin.strip_prefix("http://") {
        (false, r)
    } else {
        return false;
    };

    // Reject path, query, fragment, or userinfo injection
    if rest.is_empty() || rest.contains('/') || rest.contains('@') || rest.contains('?') || rest.contains('#') {
        return false;
    }

    let host = rest.split(':').next().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }

    // Local development hosts allowed over http or https
    if host == "localhost" || host == "127.0.0.1" {
        return true;
    }

    // Remote origins must use HTTPS
    if !is_https {
        return false;
    }

    const ALLOWED_DOMAINS: &[&str] = &[
        "miro.com",
        "figma.com",
        "penpot.app",
        "syncingboard.com",
        "protokoba.com",
        "luiskobayashi.com",
        "vercel.app",
        "trycloudflare.com",
    ];

    if ALLOWED_DOMAINS.iter().any(|domain| {
        host == *domain || host.ends_with(&format!(".{}", domain))
    }) {
        return true;
    }

    if let Ok(extra) = std::env::var("SYNCINGBRIDGE_ALLOWED_ORIGINS") {
        for raw in extra.split(',') {
            let domain = raw.trim().to_ascii_lowercase();
            if !domain.is_empty() && (host == domain || host.ends_with(&format!(".{}", domain))) {
                return true;
            }
        }
    }

    false
}

/// Middleware that enforces origin allowlist and adds CORS + Private Network Access (PNA) headers.
async fn add_cors_and_pna(
    State(state): State<AppState>,
    request: axum::http::Request<axum::body::Body>,
    next: middleware::Next,
) -> impl IntoResponse {
    let method = request.method().clone();
    let origin = request
        .headers()
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    if !is_allowed_origin(&origin) {
        state
            .log("Security", format!("Blocked request from untrusted origin: {}", origin))
            .await;
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({ "error": "Origin not allowed by SyncingBridge" })),
        )
            .into_response();
    }

    let ac_origin = if origin.is_empty() {
        HeaderValue::from_static("*")
    } else {
        HeaderValue::from_str(&origin).unwrap_or(HeaderValue::from_static("*"))
    };

    // For OPTIONS preflight (CORS + PNA), return 204 with all headers
    if method == axum::http::Method::OPTIONS {
        let headers = [
            (HeaderName::from_static("access-control-allow-origin"), ac_origin),
            (HeaderName::from_static("access-control-allow-methods"), HeaderValue::from_static("GET, POST, OPTIONS")),
            (HeaderName::from_static("access-control-allow-headers"), HeaderValue::from_static("Content-Type, Authorization, X-Figma-Token, X-Bridge-Port")),
            (HeaderName::from_static("access-control-allow-private-network"), HeaderValue::from_static("true")),
            (HeaderName::from_static("access-control-max-age"), HeaderValue::from_static("86400")),
        ];
        return (StatusCode::NO_CONTENT, headers).into_response();
    }

    let mut response = next.run(request).await;

    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-origin"),
        ac_origin,
    );
    response.headers_mut().insert(
        HeaderName::from_static("access-control-allow-private-network"),
        HeaderValue::from_static("true"),
    );

    response
}

async fn start_local_server(state: AppState, mut port_rx: watch::Receiver<u16>) {
    loop {
        let current_port = *port_rx.borrow_and_update();

        let app = Router::new()
            .route("/health", get(handle_health))
            .route("/miro/connect", post(handle_miro_connect))
            .route(
                "/miro/update-image",
                post(handle_miro_update_image).layer(DefaultBodyLimit::max(50 * 1024 * 1024)),
            )
            .route("/ws", get(handle_ws_upgrade))
            .route("/relay", get(handle_ws_upgrade))
            .route_layer(middleware::from_fn_with_state(state.clone(), add_cors_and_pna))
            .with_state(state.clone());

        let addr = std::net::SocketAddr::from(([127, 0, 0, 1], current_port));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind TCP listener on 127.0.0.1:{}: {}", current_port, e);
                state
                    .emit_status(
                        "error",
                        0,
                        Some(format!("[Bridge] Port {} bind failed: {}", current_port, e)),
                    )
                    .await;
                if port_rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
        };

        {
            let mut p = state.broker_port.lock().await;
            *p = current_port;
        }

        state
            .log(
                "Bridge",
                format!(
                    "Listening on ws://127.0.0.1:{}/ws and http://127.0.0.1:{}",
                    current_port, current_port
                ),
            )
            .await;
        state
            .log(
                "Bridge",
                "Ready \u{2014} accepting local connections from Figma, Miro, and Penpot.",
            )
            .await;

        tokio::select! {
            res = axum::serve(listener, app) => {
                if let Err(e) = res {
                    eprintln!("Axum server shut down with error: {}", e);
                    state.emit_status("error", 0, Some(format!("[Bridge] Server shut down: {}", e))).await;
                }
                if port_rx.changed().await.is_err() {
                    return;
                }
            }
            changed = port_rx.changed() => {
                if changed.is_err() {
                    return;
                }
                let next_port = *port_rx.borrow();
                state.log("Bridge", format!("Rebinding local broker to port {}\u{2026}", next_port)).await;
            }
        }
    }
}

// ── WebSocket Handler ────────────────────────────────────────────────────────
async fn handle_ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    if !*state.broker_enabled.lock().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "status": "paused", "error": "Local broker is paused" })),
        )
            .into_response();
    }
    ws.on_upgrade(move |socket| handle_ws_socket(socket, state))
}

async fn handle_ws_socket(socket: WebSocket, state: AppState) {
    let conn_id = state.next_conn_id.fetch_add(1, Ordering::Relaxed);
    let mut enabled_rx = state.enabled_tx.subscribe();
    {
        let mut count = state.active_connections.lock().await;
        *count += 1;
    }
    state.log("WebSocket", "Client connected to local broker.").await;

    let (mut sender, mut receiver) = socket.split();
    let mut current_pairing_id: Option<String> = None;
    let mut current_role: Option<String> = None;
    let mut current_platform: Option<String> = None;
    let mut broadcast_rx: Option<broadcast::Receiver<(u64, String)>> = None;

    loop {
        tokio::select! {
            // Disconnect active clients immediately when broker is paused
            changed = enabled_rx.changed() => {
                if changed.is_ok() && !*enabled_rx.borrow() {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            }

            // Inbound messages from WebSocket client
            msg = receiver.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(parsed) = serde_json::from_str::<WsPayload>(&text) {
                            match parsed.action.as_str() {
                                "register" => {
                                    if let Some(pid) = parsed.pairing_id {
                                        let bcast_sender = state.get_or_create_channel(&pid).await;
                                        broadcast_rx = Some(bcast_sender.subscribe());
                                        current_pairing_id = Some(pid.clone());

                                        let role = parsed.role.as_deref()
                                            .or_else(|| {
                                                parsed.payload.as_ref()
                                                    .and_then(|p| p.get("role"))
                                                    .and_then(|r| r.as_str())
                                            })
                                            .unwrap_or("source")
                                            .to_string();

                                        let platform_label = match parsed.platform.as_deref() {
                                            Some("penpot") => "Penpot",
                                            Some("figjam") => "FigJam",
                                            Some("miro") => "Miro",
                                            _ => "Figma",
                                        };

                                        if current_role.is_none() {
                                            if role == "target" || role == "miro" || role == "figjam" {
                                                let mut t = state.targets_count.lock().await;
                                                *t += 1;
                                                drop(t);
                                                state.set_service_connection("miro", true).await;
                                            } else {
                                                let mut s = state.sources_count.lock().await;
                                                *s += 1;
                                                drop(s);
                                                state.set_service_connection("figma", true).await;
                                                state.log(
                                                    platform_label,
                                                    format!("Connected \u{2014} {} Companion plugin is now linked to SyncingBridge (channel {})", platform_label, pid),
                                                ).await;
                                            }
                                            current_role = Some(role.clone());
                                            current_platform = Some(platform_label.to_string());
                                        }

                                        state.log("Relay", format!("Client registered on channel {} ({})", pid, role)).await;

                                        let ack = serde_json::json!({
                                            "action": "registered",
                                            "pairing_id": pid,
                                            "role": role,
                                            "status": "ok"
                                        });
                                        let _ = sender.send(Message::Text(ack.to_string())).await;
                                    }
                                }
                                "broadcast" => {
                                    if let Some(pid) = parsed.pairing_id.as_ref().or(current_pairing_id.as_ref()) {
                                        let event_name = parsed.event.as_deref().unwrap_or("message");
                                        if event_name == "sync-event" {
                                            if let Some(payload) = parsed.payload.as_ref() {
                                                if let Some(msg) = payload.get("message").and_then(|m| m.as_str()) {
                                                    state.log("Sync", format!("[Channel: {}] {}", pid, msg)).await;
                                                }
                                            }
                                        } else if event_name == "command" {
                                            let action = parsed.payload.as_ref()
                                                .and_then(|p| p.get("action"))
                                                .and_then(|a| a.as_str())
                                                .unwrap_or("query");
                                            state.log("Transport", format!("[Channel: {}] Miro -> Companion: Request '{}' ({} bytes)", pid, action, text.len())).await;
                                        } else if event_name == "result" {
                                            state.log("Transport", format!("[Channel: {}] Companion -> Miro: Result delivered ({} bytes)", pid, text.len())).await;
                                        } else if event_name == "selection" {
                                            state.log("Transport", format!("[Channel: {}] Companion -> Miro: Live selection stream ({} bytes)", pid, text.len())).await;
                                        } else {
                                            state.log("Transport", format!("[Channel: {}] Relayed '{}' ({} bytes)", pid, event_name, text.len())).await;
                                        }
                                        let bcast_sender = state.get_or_create_channel(pid).await;
                                        // Send text message to channel peers (excluding self)
                                        let _ = bcast_sender.send((conn_id, text));
                                    }
                                }
                                "health" => {
                                    let figma_connected = state.is_service_connected("figma").await;
                                    let miro_connected = state.is_service_connected("miro").await;
                                    let sessions = *state.active_connections.lock().await;
                                    let port = *state.broker_port.lock().await;
                                    let resp = serde_json::json!({
                                        "action": "health-result",
                                        "status": "ok",
                                        "version": "0.17.2",
                                        "figmaConnected": figma_connected,
                                        "miroConnected": miro_connected,
                                        "sessions": sessions,
                                        "port": port,
                                        "wsUrl": format!("ws://127.0.0.1:{}/ws", port)
                                    });
                                    let _ = sender.send(Message::Text(resp.to_string())).await;
                                }
                                "ping" => {
                                    let pong = serde_json::json!({ "action": "pong", "time": Date_now_secs() });
                                    let _ = sender.send(Message::Text(pong.to_string())).await;
                                }
                                _ => {
                                    // Default: if pairing_id exists, relay to peers (excluding self)
                                    if let Some(pid) = current_pairing_id.as_ref() {
                                        let bcast_sender = state.get_or_create_channel(pid).await;
                                        let _ = bcast_sender.send((conn_id, text));
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Binary(bin))) => {
                        // Forward raw binary chunks to all channel peers (excluding self)
                        if let Some(pid) = current_pairing_id.as_ref() {
                            let bcast_sender = state.get_or_create_channel(pid).await;
                            // Encode binary buffer message
                            let msg_wrapper = serde_json::json!({
                                "action": "binary-chunk",
                                "pairing_id": pid,
                                "data": data_encoding::BASE64.encode(&bin),
                            });
                            let _ = bcast_sender.send((conn_id, msg_wrapper.to_string()));
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    _ => {}
                }
            }

            // Outbound broadcast messages to this WebSocket client
            bcast_msg = async {
                if let Some(rx) = broadcast_rx.as_mut() {
                    rx.recv().await
                } else {
                    futures_util::future::pending().await
                }
            } => {
                if let Ok((sender_id, text)) = bcast_msg {
                    if sender_id != conn_id {
                        let _ = sender.send(Message::Text(text)).await;
                    }
                }
            }
        }
    }

    // Drop subscription before pruning so receiver_count() reflects disconnect
    drop(broadcast_rx);
    if let Some(ref pid) = current_pairing_id {
        state.prune_channel_if_empty(pid).await;
    }

    {
        let mut count = state.active_connections.lock().await;
        if *count > 0 {
            *count -= 1;
        }
        drop(count);
        if let Some(ref role) = current_role {
            if role == "target" || role == "miro" || role == "figjam" {
                let mut t = state.targets_count.lock().await;
                if *t > 0 { *t -= 1; }
                let remaining = *t;
                drop(t);
                if remaining == 0 {
                    state.set_service_connection("miro", false).await;
                }
            } else {
                let mut s = state.sources_count.lock().await;
                if *s > 0 { *s -= 1; }
                let remaining = *s;
                drop(s);
                if remaining == 0 {
                    state.set_service_connection("figma", false).await;
                }
            }
        }
    }
    match (current_role.as_deref(), current_platform.as_deref(), current_pairing_id.as_deref()) {
        (Some("target" | "miro" | "figjam"), _, Some(pid)) => {
            state.log("Miro", format!("Disconnected from SyncingBridge (channel {}).", pid)).await;
        }
        (Some("target" | "miro" | "figjam"), _, None) => {
            state.log("Miro", "Disconnected from local broker.").await;
        }
        (Some(_), Some(plat), Some(pid)) => {
            state.log(plat, format!("Disconnected from SyncingBridge (channel {}).", pid)).await;
        }
        (Some(_), Some(plat), None) => {
            state.log(plat, "Disconnected from local broker.").await;
        }
        (Some(role), None, Some(pid)) => {
            state.log("WebSocket", format!("Source ({}) disconnected from channel {}.", role, pid)).await;
        }
        (Some(role), None, None) => {
            state.log("WebSocket", format!("Source ({}) disconnected from local broker.", role)).await;
        }
        (None, _, Some(pid)) => {
            state.log("WebSocket", format!("Client disconnected from channel {}.", pid)).await;
        }
        (None, _, None) => {
            state.log("WebSocket", "Client disconnected from local broker.").await;
        }
    }
}

#[allow(non_snake_case)]
fn Date_now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── Silent Health Check ─────────────────────────────────────────────────────
async fn handle_health(State(state): State<AppState>) -> impl IntoResponse {
    if !*state.broker_enabled.lock().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "status": "paused",
                "error": "Local broker is paused"
            })),
        );
    }

    let figma_connected = state.is_service_connected("figma").await;
    let miro_connected = state.is_service_connected("miro").await;
    let sessions = *state.active_connections.lock().await;
    let port = *state.broker_port.lock().await;

    (StatusCode::OK, Json(serde_json::json!({
        "status": "ok",
        "version": "0.17.2",
        "figmaConnected": figma_connected,
        "miroConnected": miro_connected,
        "sessions": sessions,
        "port": port,
        "wsUrl": format!("ws://127.0.0.1:{}/ws", port)
    })))
}

/// Called once by the Miro plugin when the user connects to the bridge.
async fn handle_miro_connect(State(state): State<AppState>) -> impl IntoResponse {
    state.set_service_connection("miro", true).await;
    state.log("Miro", "Connected \u{2014} SyncingBoard plugin is now linked to SyncingBridge").await;
    (StatusCode::OK, Json(serde_json::json!({ "status": "connected" })))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MiroUpdateImageRequest {
    board_id: String,
    item_id: String,
    #[serde(default)]
    node_name: String,
    #[serde(default)]
    width: Option<f64>,
    data_url: String,
    #[serde(default = "default_format")]
    format: String,
    #[serde(default)]
    preserve_size: bool,
}

fn default_format() -> String {
    "png".to_string()
}

fn is_valid_miro_board_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '=' | '|' | '-'))
}

fn is_valid_miro_item_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn decode_image_data_url(data_url: &str, format: &str) -> Result<(Vec<u8>, &'static str, &'static str), String> {
    let (_, b64_part) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid dataUrl format".to_string())?;
    let bytes = data_encoding::BASE64
        .decode(b64_part.trim().as_bytes())
        .map_err(|e| format!("Invalid base64 image payload: {}", e))?;
    if bytes.is_empty() {
        return Err("Empty image payload".to_string());
    }
    let is_svg = format.eq_ignore_ascii_case("svg") || data_url.starts_with("data:image/svg+xml");
    if is_svg {
        Ok((bytes, "sync.svg", "image/svg+xml"))
    } else {
        Ok((bytes, "sync.png", "image/png"))
    }
}

/// Local Miro REST API v2 image PATCH proxy (0 Vercel calls, 50 MB body limit).
async fn handle_miro_update_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<MiroUpdateImageRequest>,
) -> impl IntoResponse {
    if !*state.broker_enabled.lock().await {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "Local broker is paused" })),
        );
    }

    let miro_token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
        .unwrap_or("")
        .trim()
        .to_string();

    if miro_token.is_empty() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "Missing Miro Authorization Bearer token" })),
        );
    }

    if !is_valid_miro_board_id(&body.board_id) || !is_valid_miro_item_id(&body.item_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid boardId or itemId format" })),
        );
    }

    let (image_bytes, filename, mime_type) = match decode_image_data_url(&body.data_url, &body.format) {
        Ok(decoded) => decoded,
        Err(msg) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": msg })),
            );
        }
    };

    let byte_len = image_bytes.len();
    // Strict allowlist validation on Miro board_id and item_id to prevent SSRF / path traversal
    let is_valid_miro_id = |id: &str| -> bool {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'=' | b'+'))
    };
    if !is_valid_miro_id(&body.board_id) || !is_valid_miro_id(&body.item_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "Invalid Miro board_id or item_id format" })),
        );
    }

    let mut parsed_url = match reqwest::Url::parse("https://api.miro.com/v2/boards/") {
        Ok(u) => u,
        Err(_) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "Failed to construct Miro API URL" })),
            );
        }
    };
    if let Ok(mut segments) = parsed_url.path_segments_mut() {
        segments.pop_if_empty();
        segments.push(&body.board_id);
        segments.push("images");
        segments.push(&body.item_id);
    }
    let image_url = parsed_url.to_string();
    let auth_value = format!("Bearer {}", miro_token);
    let client = reqwest::Client::new();

    // Step 1 (preserveSize): snapshot current geometry width before upload
    let mut snapshot_width: Option<f64> = None;
    if body.preserve_size {
        if let Ok(snap_res) = client
            .get(&image_url)
            .header("Authorization", &auth_value)
            .header("Accept", "application/json")
            .send()
            .await
        {
            if snap_res.status().is_success() {
                if let Ok(snap_json) = snap_res.json::<serde_json::Value>().await {
                    snapshot_width = snap_json
                        .get("geometry")
                        .and_then(|g| g.get("width"))
                        .and_then(|w| w.as_f64())
                        .or_else(|| snap_json.get("width").and_then(|w| w.as_f64()));
                }
            }
        }
    }

    // Step 2: multipart PATCH image binary directly to Miro REST API v2
    let part = match reqwest::multipart::Part::bytes(image_bytes)
        .file_name(filename.to_string())
        .mime_str(mime_type)
    {
        Ok(p) => p,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("Failed to build multipart payload: {}", e) })),
            );
        }
    };

    let mut form = reqwest::multipart::Form::new().part("resource", part);
    if !body.preserve_size {
        if let Some(w) = body.width {
            if w.is_finite() && w > 0.0 {
                let meta = serde_json::json!({ "geometry": { "width": w } }).to_string();
                form = form.text("data", meta);
            }
        }
    }

    let upload_res = match client
        .patch(&image_url)
        .header("Authorization", &auth_value)
        .header("Accept", "application/json")
        .multipart(form)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": format!("Miro API request failed: {}", e) })),
            );
        }
    };

    let upload_status = upload_res.status();
    if !upload_status.is_success() {
        let err_json = upload_res
            .json::<serde_json::Value>()
            .await
            .unwrap_or_else(|_| serde_json::json!({ "message": "Miro image update failed" }));
        let msg = err_json
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Miro image update failed");
        let code = StatusCode::from_u16(upload_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return (code, Json(serde_json::json!({ "error": msg })));
    }

    let updated_data = upload_res
        .json::<serde_json::Value>()
        .await
        .unwrap_or_else(|_| serde_json::json!({}));

    // Step 3 (preserveSize): re-apply geometry width with up to 3 retry attempts
    let target_width = snapshot_width.or(body.width);
    if body.preserve_size {
        if let Some(tw) = target_width {
            if tw.is_finite() && tw > 0.0 {
                for attempt in 0..3u32 {
                    let geo_meta = serde_json::json!({ "geometry": { "width": tw } }).to_string();
                    let geo_form = reqwest::multipart::Form::new().text("data", geo_meta);
                    let geo_res = client
                        .patch(&image_url)
                        .header("Authorization", &auth_value)
                        .header("Accept", "application/json")
                        .multipart(geo_form)
                        .send()
                        .await;

                    if let Ok(resp) = geo_res {
                        if resp.status().as_u16() == 429 && attempt < 2 {
                            let retry_secs = resp
                                .headers()
                                .get("retry-after")
                                .and_then(|v| v.to_str().ok())
                                .and_then(|s| s.parse::<u64>().ok())
                                .unwrap_or(1)
                                .min(10);
                            tokio::time::sleep(std::time::Duration::from_secs(retry_secs)).await;
                            continue;
                        }
                        if resp.status().is_success() {
                            if let Ok(verify_res) = client
                                .get(&image_url)
                                .header("Authorization", &auth_value)
                                .header("Accept", "application/json")
                                .send()
                                .await
                            {
                                if let Ok(vjson) = verify_res.json::<serde_json::Value>().await {
                                    let confirmed = vjson
                                        .get("geometry")
                                        .and_then(|g| g.get("width"))
                                        .and_then(|w| w.as_f64())
                                        .or_else(|| vjson.get("width").and_then(|w| w.as_f64()));
                                    if let Some(cw) = confirmed {
                                        if (cw - tw).abs() < 1.0 {
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if attempt < 2 {
                        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                    }
                }
            }
        }
    }

    let label = if body.node_name.is_empty() {
        body.item_id.as_str()
    } else {
        body.node_name.as_str()
    };
    state
        .log(
            "Miro",
            format!("Updated '{}' locally ({} KB, 0 Vercel calls)", label, (byte_len + 1023) / 1024),
        )
        .await;

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "data": updated_data,
            "local": true
        })),
    )
}

#[tauri::command]
async fn get_bridge_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let sessions = *state.active_connections.lock().await;
    let sources = *state.sources_count.lock().await;
    let targets = *state.targets_count.lock().await;
    let enabled = *state.broker_enabled.lock().await;
    let port = *state.broker_port.lock().await;
    Ok(serde_json::json!({
        "status": if enabled { "active" } else { "paused" },
        "sessions": sessions,
        "sources": sources,
        "targets": targets,
        "port": port,
    }))
}

#[tauri::command]
async fn set_broker_enabled(enabled: bool, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    {
        let mut flag = state.broker_enabled.lock().await;
        *flag = enabled;
    }
    let _ = state.enabled_tx.send(enabled);
    let sessions = *state.active_connections.lock().await;
    let port = *state.broker_port.lock().await;
    let status = if enabled { "active" } else { "paused" };
    let msg = if enabled {
        format!("[Bridge] Local broker resumed on ws://127.0.0.1:{}", port)
    } else {
        "[Bridge] Local broker paused \u{2014} clients will fall back to Cloud Relay".to_string()
    };
    state.emit_status(status, sessions, Some(msg)).await;
    Ok(serde_json::json!({
        "status": status,
        "enabled": enabled,
        "port": port,
    }))
}

#[tauri::command]
async fn set_broker_port(port: u16, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    if port < 1024 {
        return Err("Port must be between 1024 and 65535".to_string());
    }
    let current = *state.broker_port.lock().await;
    if current == port {
        return Ok(serde_json::json!({
            "status": "unchanged",
            "port": port,
        }));
    }
    state
        .port_tx
        .send(port)
        .map_err(|e| format!("Failed to signal port change: {}", e))?;
    Ok(serde_json::json!({
        "status": "rebinding",
        "port": port,
    }))
}

#[tauri::command]
async fn get_hotkeys(state: tauri::State<'_, AppState>) -> Result<HotkeyConfig, String> {
    Ok(state.hotkeys.lock().await.clone())
}

#[tauri::command]
async fn set_hotkeys(
    import: String,
    replace: String,
    sync: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<HotkeyConfig, String> {
    let next = HotkeyConfig {
        import: import.trim().to_string(),
        replace: replace.trim().to_string(),
        sync: sync.trim().to_string(),
    };
    register_hotkeys(&app, state.inner().clone(), &next)?;
    *state.hotkeys.lock().await = next.clone();
    save_hotkeys_to_disk(&app, &next);
    state
        .log(
            "Hotkeys",
            format!(
                "Updated shortcuts (Import: '{}', Replace: '{}', Sync: '{}')",
                if next.import.is_empty() { "off" } else { &next.import },
                if next.replace.is_empty() { "off" } else { &next.replace },
                if next.sync.is_empty() { "off" } else { &next.sync }
            ),
        )
        .await;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_expected_origins() {
        assert!(is_allowed_origin(""));
        assert!(is_allowed_origin("null"));
        assert!(is_allowed_origin("http://localhost:3000"));
        assert!(is_allowed_origin("http://127.0.0.1:4401"));
        assert!(is_allowed_origin("https://miro.com"));
        assert!(is_allowed_origin("https://app.miro.com"));
        assert!(is_allowed_origin("https://www.figma.com"));
        assert!(is_allowed_origin("https://design.penpot.app"));
        assert!(is_allowed_origin("https://syncingboard.vercel.app"));
        assert!(is_allowed_origin("https://demo.trycloudflare.com"));
        assert!(is_allowed_origin("https://syncingboard.com"));
    }

    #[test]
    fn rejects_untrusted_and_spoofed_origins() {
        assert!(!is_allowed_origin("https://evil.com"));
        assert!(!is_allowed_origin("https://evil-miro.com"));
        assert!(!is_allowed_origin("https://miro.com.evil.com"));
        assert!(!is_allowed_origin("http://miro.com"));
        assert!(!is_allowed_origin("https://miro.com@evil.com"));
        assert!(!is_allowed_origin("javascript:alert(1)"));
    }

    #[tokio::test]
    async fn prunes_empty_channels_on_disconnect() {
        let (port_tx, _port_rx) = watch::channel(4401u16);
        let (enabled_tx, _enabled_rx) = watch::channel(true);
        let state = AppState {
            channels: Arc::new(Mutex::new(HashMap::new())),
            next_conn_id: Arc::new(AtomicU64::new(1)),
            active_connections: Arc::new(Mutex::new(0)),
            sources_count: Arc::new(Mutex::new(0)),
            targets_count: Arc::new(Mutex::new(0)),
            broker_enabled: Arc::new(Mutex::new(true)),
            enabled_tx: Arc::new(enabled_tx),
            broker_port: Arc::new(Mutex::new(4401)),
            port_tx: Arc::new(port_tx),
            hotkeys: Arc::new(Mutex::new(HotkeyConfig::default())),
            service_connections: Arc::new(Mutex::new(HashMap::new())),
            app_handle: Arc::new(Mutex::new(None)),
        };

        let tx = state.get_or_create_channel("pair-1").await;
        let rx = tx.subscribe();
        state.prune_channel_if_empty("pair-1").await;
        assert!(state.channels.lock().await.contains_key("pair-1"));

        drop(rx);
        state.prune_channel_if_empty("pair-1").await;
        assert!(!state.channels.lock().await.contains_key("pair-1"));
    }

    #[test]
    fn validates_miro_ids() {
        assert!(is_valid_miro_board_id("uXjVM_xyz123="));
        assert!(is_valid_miro_item_id("3458764523456789"));
        assert!(!is_valid_miro_board_id("../etc/passwd"));
        assert!(!is_valid_miro_item_id("123/../../hack"));
        assert!(!is_valid_miro_board_id(""));
    }

    #[test]
    fn decodes_data_url_payload() {
        let (bytes, name, mime) = decode_image_data_url("data:image/png;base64,iVBORw0K", "png").unwrap();
        assert!(!bytes.is_empty());
        assert_eq!(name, "sync.png");
        assert_eq!(mime, "image/png");

        let (svg_bytes, svg_name, svg_mime) = decode_image_data_url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "svg").unwrap();
        assert_eq!(svg_bytes, b"<svg></svg>");
        assert_eq!(svg_name, "sync.svg");
        assert_eq!(svg_mime, "image/svg+xml");

        assert!(decode_image_data_url("not-a-data-url", "png").is_err());
    }
}
