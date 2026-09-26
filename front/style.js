export const css = `
.nw {
  position: relative;
  overflow-anchor: none;
  --nw-bg: var(--md-bg, #ffffff);
  --nw-fg: var(--md-fg, #242424);
  --nw-muted: var(--md-fg-muted, #616161);
  --nw-line: var(--md-border, #c7c7c7);
  --nw-surface: var(--md-surface, #f3f3f3);
  --nw-accent: var(--md-accent, #005fb8);
  --nw-focus: var(--md-focus, #005fb8);
  --nw-danger: var(--md-danger, light-dark(#b42318, #ff8b82));
  /* Report tone must not reuse red/green: in finance views red already means "up". */
  --nw-tone-neg: color-mix(in srgb, var(--nw-fg) 78%, transparent);
  --nw-up: light-dark(#c8102e, #ff6b6b);
  --nw-down: light-dark(#0f7b3f, #4fd18b);
  --nw-mixed: light-dark(#b7791f, #f0b429);
  --nw-idle: color-mix(in srgb, var(--nw-muted) 45%, transparent);
  container-type: inline-size;
  margin: 8px;
  background: var(--nw-bg);
  color: var(--nw-fg);
  font: 14px/1.5 "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
  font-variant-numeric: tabular-nums;
}
.nw *, .nw *::before, .nw *::after { box-sizing: border-box; }
.nw [hidden] { display: none !important; }
.nw .nw-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
.nw button, .nw select, .nw input {
  font: inherit;
  color: var(--nw-fg);
  background: var(--nw-bg);
  border: 1px solid var(--nw-line);
  border-radius: 5px;
  padding: 5px 9px;
  max-width: 100%;
}
.nw button { cursor: pointer; }
.nw button:disabled, .nw button[aria-disabled="true"] { cursor: default; color: var(--nw-muted); }
.nw button:focus-visible, .nw a:focus-visible, .nw select:focus-visible, .nw input:focus-visible {
  outline: 2px solid var(--nw-focus);
  outline-offset: 2px;
}
.nw .nw-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 0 12px; }
.nw .nw-toolbar-actions { display: contents; }
.nw .nw-panel-toggle { width: 100%; text-align: left; background: transparent; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw .nw-panel-toggle::after { content: " ▸" / ""; }
.nw .nw-panel-toggle[aria-expanded="true"]::after { content: " ▾" / ""; }
.nw .nw-panel-toggle[aria-expanded="true"] { margin-bottom: 12px; }
.nw .nw-overview { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 4px; flex-basis: 100%; min-width: 0; }
.nw .nw-overview-heading { white-space: nowrap; }
.nw .nw-overview-segment { display: inline-flex; align-items: baseline; min-width: 0; max-width: 100%; }
.nw .nw-overview-separator { flex: none; }
.nw .nw-overview-button { font-size: 12px; color: var(--nw-muted); background: transparent; border: 0; padding: 1px 0; white-space: normal; text-align: left; min-width: 0; overflow-wrap: anywhere; }
.nw .nw-overview-button:hover { text-decoration: underline; text-underline-offset: 3px; }
.nw .nw-search-box { display: flex; flex-wrap: wrap; gap: 8px; flex-basis: 100%; min-width: 0; }
.nw .nw-search-input { flex: 1 1 180px; min-width: 0; max-width: 100%; }
.nw .nw-search-hint { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.nw .nw-search-match { color: var(--nw-accent); font-size: 12px; }
.nw .nw-new-only[aria-pressed="true"] { border-color: var(--nw-accent); box-shadow: inset 0 -2px var(--nw-accent); }
.nw .nw-new-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-block: 8px; }
.nw .nw-status-group { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-left: auto; min-width: 0; max-width: 100%; }
.nw .nw-status-group .nw-status { flex: 1; min-width: 0; margin-left: 0; }
.nw .nw-new-only, .nw .nw-mark-read, .nw .nw-undo-read, .nw .nw-shortcut-toggle { flex: none; box-sizing: border-box; min-height: 30px; font-size: 12px; padding: 5px 9px; border: 1px solid var(--nw-line); background: transparent; color: var(--nw-fg); }
.nw .nw-new-only:hover, .nw .nw-mark-read:hover, .nw .nw-undo-read:hover, .nw .nw-shortcut-toggle:hover { border-color: var(--nw-accent); text-decoration: underline; }
.nw .nw-shortcut-icon { display: none; }
.nw .nw-shortcut-help { margin: 8px 16px; padding: 12px; border: 1px solid var(--nw-line); border-radius: 5px; }
.nw .nw-shortcut-help:focus-visible { outline: 2px solid var(--nw-focus); outline-offset: 2px; }
.nw .nw-shortcut-list { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 8px 0 0; font-size: 12px; }
.nw .nw-shortcut-list dt { font-weight: 600; }
.nw .nw-shortcut-list dd { margin: 0; overflow-wrap: anywhere; }
.nw .nw-status { margin-left: auto; font-size: 12px; color: var(--nw-muted); }
.nw .nw-watch-settings { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex-basis: 100%; }
.nw .nw-watch-input { flex: 1 1 220px; min-width: 0; }
.nw .nw-watch { color: var(--nw-accent); border: 1px solid var(--nw-accent); border-radius: 3px; padding: 0 4px; font-size: 12px; }
.nw .nw-panel { background: var(--nw-surface); border-radius: 8px; padding: 14px 16px; }
.nw .nw-focus-section { background: var(--nw-surface); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.nw .nw-focus-section.nw-focus-empty { background: transparent; padding: 0 16px; border-radius: 0; }
.nw .nw-focus-empty .nw-hint { margin: 0; }
.nw .nw-watch-guide { flex-basis: 100%; }
.nw .nw-focus-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.nw .nw-event-latest { display: block; min-width: 0; text-decoration: none; }
.nw a.nw-event-latest:hover { text-decoration: underline; }
.nw .nw-focus-list { display: grid; gap: 10px; }
.nw .nw-focus-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.nw .nw-focus-count { font-size: 12px; white-space: nowrap; }
.nw .nw-focus-count[data-topic-id][aria-pressed="true"], .nw .nw-watch-only[aria-pressed="true"] { border-color: var(--nw-accent); box-shadow: inset 3px 0 0 var(--nw-accent); }
.nw .nw-focus-short { display: none; }
.nw .nw-focus-copy { min-width: 0; }
.nw .nw-topic-latest, .nw .nw-event-latest { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nw .nw-tone-labels { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
.nw .nw-tone-button { font-size: 12px; border: 0; border-radius: 0; background: transparent; padding: 1px 0; white-space: nowrap; text-underline-offset: 3px; }
.nw .nw-tone-button strong { font-weight: 700; }
.nw .nw-tone-button:hover { text-decoration: underline; }
.nw .nw-tone-button[aria-pressed="true"] { text-decoration: underline; text-decoration-thickness: 2px; }
.nw .nw-tone-text-positive { color: var(--nw-accent); }
.nw .nw-tone-text-negative { color: var(--nw-tone-neg); }
.nw .nw-tone-text-mixed { color: var(--nw-mixed); }
.nw .nw-tone-text-neutral { color: var(--nw-muted); }
.nw .nw-tone-audit { grid-column: 1 / -1; min-width: 0; border-top: 1px solid var(--nw-line); padding-top: 8px; }
.nw .nw-tone-reports { margin: 8px 0 0; padding-left: 16px; }
.nw .nw-tone-report { min-width: 0; margin-block: 8px; overflow-wrap: anywhere; }
.nw .nw-tone-report a { color: var(--nw-accent); }
.nw .nw-tone-audit .nw-heading { overflow-wrap: anywhere; }
.nw .nw-tone { margin-top: 6px; }
.nw .nw-bar.nw-tone-bar { height: 4px; margin-bottom: 4px; }
.nw .nw-tone-negative { background: var(--nw-tone-neg); }
.nw .nw-tone-positive { background: var(--nw-accent); }
.nw .nw-tone-mixed { background: var(--nw-mixed); }
.nw .nw-tone-neutral { background: var(--nw-idle); }
.nw .nw-tone-tag { font-size: 12px; border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; }
.nw .nw-tone-tag-positive { color: var(--nw-accent); }
.nw .nw-tone-tag-negative { color: var(--nw-tone-neg); }
.nw .nw-tone-tag-mixed { color: var(--nw-mixed); }
.nw .nw-tone-tag-neutral { color: var(--nw-muted); }
.nw .nw-sample { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 18px; color: var(--nw-muted); font-size: 12px; }
.nw .nw-pending { margin-left: auto; }
.nw .nw-warning { flex-basis: 100%; }
.nw .nw-heading { font-size: 14px; font-weight: 500; margin: 0 0 8px; }
.nw .nw-bar { display: flex; height: 10px; overflow: hidden; border-radius: 3px; }
.nw .nw-bar[data-empty="true"] { background: var(--nw-idle); }
.nw .nw-segment { display: block; flex: 0 0 auto; height: 100%; transition: width 240ms ease; }
.nw .nw-positive, .nw .nw-bull { background: var(--nw-up); }
.nw .nw-negative, .nw .nw-bear { background: var(--nw-down); }
.nw .nw-mixed { background: var(--nw-mixed); }
.nw .nw-idle { background: var(--nw-idle); }
.nw .nw-issue-count { background: var(--nw-accent); }
.nw .nw-escalation { background: var(--nw-danger); }
.nw .nw-deescalation { background: var(--nw-accent); }
.nw .nw-danger-text { color: var(--nw-danger); }
.nw .nw-calm-text { color: var(--nw-accent); }
.nw .nw-legend { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 8px 0 18px; }
.nw .nw-legend-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; color: var(--nw-muted); font-size: 12px; }
.nw .nw-panel button[data-count] { text-align: left; background: transparent; }
.nw .nw-panel button[data-count][aria-pressed="true"] { border-color: var(--nw-accent); box-shadow: inset 0 -2px var(--nw-accent); }
.nw .nw-dot { width: 6px; height: 6px; border-radius: 50%; align-self: center; flex: 0 0 auto; }
.nw .nw-value { font-size: 20px; font-weight: 600; color: var(--nw-fg); }
.nw .nw-history { margin-bottom: 18px; }
/* Disclosure cue; decorative, the state is in aria-expanded. */
.nw .nw-history-toggle::after { content: " ▸" / ""; color: var(--nw-muted); }
.nw .nw-history-toggle[aria-expanded="true"]::after { content: " ▾" / ""; }
.nw .nw-history-row { white-space: nowrap; display: grid; grid-template-columns: 11ch minmax(0, 1fr) 6em; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--nw-muted); }
.nw .nw-history-bar { height: 6px; }
.nw .nw-history-value { text-align: right; }
.nw .nw-history-short { display: none; }
.nw .nw-macro { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0 0 18px; }
.nw .nw-up { color: var(--nw-up); }
.nw .nw-down { color: var(--nw-down); }
.nw .nw-signal-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.nw .nw-ranking-legend { display: inline-flex; flex-wrap: wrap; align-items: center; }
.nw .nw-ranking-key { display: inline-flex; align-items: center; gap: 4px; }
.nw .nw-ranking-heading { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.nw .nw-hint, .nw .nw-note { font-size: 12px; color: var(--nw-muted); }
.nw .nw-ranking { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px 20px; }
.nw .nw-theme {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(32px, 1fr) 3ch;
  align-items: center; gap: 10px; text-align: left;
  border: 0; border-left: 3px solid transparent; border-radius: 0;
  background: transparent; padding: 7px 8px;
  margin-left: -11px; margin-right: -8px; max-width: none;
}
.nw .nw-theme:hover { background: color-mix(in srgb, var(--nw-fg) 6%, transparent); }
.nw .nw-theme[aria-pressed="true"] { border-left-color: var(--nw-accent); }
.nw .nw-theme[aria-pressed="true"] .nw-theme-name { font-weight: 600; }
.nw .nw-theme-name { overflow-wrap: anywhere; }
.nw .nw-theme-track { min-width: 0; }
.nw .nw-theme-bar { height: 6px; transition: width 240ms ease; }
.nw .nw-theme-count { text-align: right; }
.nw .nw-note { display: block; margin-top: 16px; }
.nw .nw-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0 0; color: var(--nw-muted); font-size: 12px; }
.nw .nw-topic-tools { padding: 8px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex-basis: 100%; }
.nw .nw-outlet { display: flex; align-items: center; gap: 6px; justify-content: space-between; min-width: 0; width: 100%; text-align: left; font-size: 12px; background: transparent; padding: 4px; }
.nw .nw-outlet-name { min-width: 0; overflow-wrap: anywhere; }
.nw .nw-outlet-count { flex: none; }
.nw .nw-outlet-rows { display: grid; gap: 6px; }
.nw .nw-outlet-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(36px, .6fr) minmax(0, 1.5fr); align-items: center; gap: 8px; }
.nw .nw-outlet-bar { height: 6px; }
.nw .nw-outlet-bar.nw-small-sample { opacity: .45; }
.nw .nw-outlet-explanation { margin: 4px 0 8px; }
.nw .nw-outlet-values, .nw .nw-outlet-legend { display: flex; flex-wrap: wrap; gap: 4px 8px; }
.nw .nw-outlet-legend { margin-bottom: 8px; }
.nw .nw-outlet-tone, .nw .nw-outlet-legend-item { white-space: nowrap; }
.nw .nw-tone-swatch { display: inline-block; width: 6px; height: 6px; margin-right: 4px; vertical-align: middle; }
.nw .nw-outlet-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--nw-line); border-radius: 4px; padding: 2px 6px; margin-bottom: 8px; }
.nw .nw-topic-outlet-clear { border: 0; background: transparent; padding: 0 4px; }
.nw .nw-outlet-more { margin-top: 8px; font-size: 12px; }
.nw.nw-narrow .nw-outlet-rows { gap: 12px; }
.nw.nw-narrow .nw-outlet-rows + .nw-outlet-rows { margin-top: 12px; }
.nw.nw-narrow .nw-outlet-row { grid-template-columns: minmax(36px, .6fr) minmax(0, 1.4fr); gap: 3px 8px; }
.nw.nw-narrow .nw-outlet { grid-column: 1 / -1; }
.nw.nw-narrow .nw-outlet-values { min-width: 0; }
.nw .nw-outlet[aria-pressed="true"], .nw .nw-topic-order[aria-pressed="true"] { border-color: var(--nw-accent); box-shadow: inset 0 -2px var(--nw-accent); }
.nw .nw-date-divider { padding: 10px 16px; font-size: 12px; color: var(--nw-muted); }
.nw .nw-topic-totals { font-size: 12px; word-break: keep-all; }
.nw .nw-topic-visible { flex-basis: 100%; font-size: 12px; }
.nw .nw-topic-sources { flex-basis: 100%; overflow-wrap: anywhere; }
.nw .nw-list { list-style: none; margin: 0; padding: 0; }
.nw .nw-row { padding: 14px 0; }
.nw .nw-row + .nw-row { border-top: 1px solid var(--nw-line); }
.nw .nw-divider { display: flex; align-items: center; gap: 12px; padding: 14px 16px; font-size: 12px; color: var(--nw-accent); }
.nw .nw-divider::after { content: ""; flex: 1; border-top: 1px solid var(--nw-accent); }
.nw .nw-title { display: block; font-size: 15px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; color: var(--nw-fg); text-decoration: none; }
.nw a.nw-title:hover { color: var(--nw-accent); text-decoration: underline; }
.nw .nw-new { color: var(--nw-accent); font-size: 12px; font-weight: 700; margin-right: 6px; }
.nw .nw-topic-new { color: var(--nw-accent); font-size: 12px; margin-top: 4px; }
.nw .nw-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 5px; font-size: 12px; color: var(--nw-muted); }
.nw .nw-info { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-width: 0; }
.nw .nw-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.nw .nw-summary { font-size: 13px; color: var(--nw-muted); line-height: 1.6; margin: 8px 0 0; max-width: 42em; overflow-wrap: anywhere; }
.nw .nw-summary-label { display: block; font-size: 12px; color: var(--nw-muted); }
.nw .nw-expand, .nw .nw-summary-toggle { color: var(--nw-muted); background: transparent; padding: 0 5px; font-size: 12px; }
.nw .nw-reports { list-style: none; margin: 10px 0 0; padding: 0 0 0 16px; border-left: 1px solid var(--nw-line); }
.nw .nw-report { padding: 6px 0; font-size: 12px; color: var(--nw-muted); }
.nw .nw-report-title { color: var(--nw-muted); font-size: 12px; text-decoration: none; overflow-wrap: anywhere; }
.nw a.nw-report-title:hover { color: var(--nw-accent); text-decoration: underline; }
.nw .nw-report-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.nw .nw-empty { padding: 32px 0; text-align: center; color: var(--nw-muted); }
.nw .nw-empty button { display: block; margin: 12px auto 0; }
.nw .nw-toolbar, .nw .nw-filter, .nw .nw-watch-hint, .nw .nw-new-hint, .nw .nw-row { padding-inline: 16px; }
.nw.nw-wide-ranking .nw-ranking { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.nw.nw-narrow .nw-toolbar > select { flex: 1 1 calc(50% - 4px); width: calc(50% - 4px); min-width: 0; }
.nw.nw-narrow .nw-toolbar-actions { display: flex; flex-wrap: nowrap; gap: 6px; width: 100%; overflow-x: auto; padding-block: 3px; }
.nw.nw-narrow .nw-toolbar-actions > button { flex: none; white-space: nowrap; font-size: 12px; padding-inline: 7px; }
.nw.nw-narrow .nw-legend { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.nw.nw-narrow .nw-legend-item { white-space: nowrap; word-break: keep-all; }
.nw.nw-narrow .nw-focus-long { display: none; }
.nw.nw-narrow .nw-focus-short { display: inline; }
.nw.nw-narrow .nw-actions { margin-left: 0; }
.nw.nw-narrow .nw-history-long { display: none; }
.nw.nw-narrow .nw-history-short { display: inline; }
.nw.nw-narrow .nw-history-row { grid-template-columns: 7.5ch minmax(0, 1fr) 6em; }
.nw.nw-narrow .nw-shortcut-name { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); clip-path: inset(50%); white-space: nowrap; }
.nw.nw-narrow .nw-shortcut-icon { display: inline; }
.nw.nw-narrow .nw-shortcut-toggle { border-radius: 50%; width: 30px; height: 30px; padding: 0; }
.nw.nw-narrow .nw-focus-long { display: none; }
.nw.nw-narrow .nw-focus-short { display: inline; }
.nw.nw-narrow .nw-status-group { flex-basis: 100%; margin-left: 0; }
.nw.nw-narrow .nw-theme { grid-template-columns: minmax(0, 1fr) 3ch; }
.nw.nw-narrow .nw-theme-track { display: none; }
@media (prefers-reduced-motion: reduce) {
  .nw .nw-segment, .nw .nw-theme-bar { transition: none; }
}

.nw .nw-topic-order-group { display: inline-flex; gap: 0; }
.nw .nw-topic-order-group button { border-radius: 0; }
.nw .nw-topic-order-group button:first-child { border-radius: 4px 0 0 4px; }
.nw .nw-topic-order-group button:last-child { border-radius: 0 4px 4px 0; }
.nw .nw-topic-order-group button[aria-pressed="true"] { border-color: var(--nw-accent); box-shadow: inset 0 -2px var(--nw-accent); }
.nw .nw-order-hint { flex-basis: 100%; }
.nw .nw-focus-toggle { width: 100%; text-align: left; }
`;

