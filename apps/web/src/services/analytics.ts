/**
 * Privacy-friendly analytics hook. There is no analytics backend: events are only
 * dispatched as a `ludo:analytics` DOM event so an operator can attach a provider of
 * their choice later. No identifiers or personal data are included, and nothing is
 * sent over the network by this module.
 */
export type AnalyticsEvent =
  | 'pwa_install_prompt_shown'
  | 'pwa_install_clicked'
  | 'pwa_install_dismissed'
  | 'pwa_installed'
  | 'pwa_update_applied'
  | 'game_started_mobile'
  | 'game_completed_mobile';

export function track(event: AnalyticsEvent, props: Record<string, string | number | boolean> = {}): void {
  try {
    window.dispatchEvent(new CustomEvent('ludo:analytics', { detail: { event, ...props } }));
  } catch {
    /* never let analytics break the game */
  }
}
