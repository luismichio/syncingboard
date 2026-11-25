/**
 * Formats a duration in seconds into a clean, human-readable string.
 *
 * Examples:
 *   - 0 / negative -> "0s"
 *   - 45           -> "45s"
 *   - 90           -> "1m 30s"
 *   - 3600         -> "1h"
 *   - 43200        -> "12h"
 *   - 45120        -> "12h 32m"
 *   - 90000        -> "1d 1h"
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s';
  const sec = Math.round(totalSeconds);

  if (sec < 60) {
    return `${sec}s`;
  }

  const minutes = Math.floor(sec / 60);
  const remainingSec = sec % 60;

  if (minutes < 60) {
    return remainingSec > 0 ? `${minutes}m ${remainingSec}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;

  if (hours < 24) {
    return remainingMin > 0 ? `${hours}h ${remainingMin}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

/**
 * Formats a cooldown duration with an optional clock-time suffix when resetAt timestamp is available
 * and duration is greater than or equal to 15 minutes.
 *
 * Examples:
 *   - 25s, resetAt              -> "25s"
 *   - 12h, resetAt: 1723719480  -> "12h (at 10:18 AM)"
 */
export function formatCooldownTime(seconds: number, resetAtTimestamp?: number | null): string {
  const durationStr = formatDuration(seconds);
  if (!resetAtTimestamp || seconds < 900) {
    // Under 15 minutes: relative duration alone is concise and clear
    return durationStr;
  }

  try {
    const d = new Date(resetAtTimestamp);
    if (isNaN(d.getTime())) return durationStr;
    const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${durationStr} (at ${timeStr})`;
  } catch {
    return durationStr;
  }
}
