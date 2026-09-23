/**
 * Light tactile feedback for mobile devices.
 * Safely checks for navigator.vibrate support and ignores silently if unsupported.
 */
export function haptic(pattern: number | number[] = 10): void {
  try {
    if (typeof window !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    // Silently ignore if disabled or unsupported by browser policy
  }
}
