import { RESET, uiRgb, dimAnsi, progressBar, getUsageColor } from '../render/colors.js';
import type { Widget, WidgetContext } from './types.js';
import type { RateLimitInfo } from '../stdin.js';

function renderPaceDelta(delta: number | null): string {
  if (delta === null || delta === 0) return '';
  if (delta > 0) {
    // Over-consuming: red up-arrow
    return ` ${uiRgb(255, 80, 80)}⇡${delta}%${RESET}`;
  }
  // Has headroom: green down-arrow
  return ` ${uiRgb(80, 220, 120)}⇣${-delta}%${RESET}`;
}

function renderRateLimit(
  label: string,
  barWidth: number,
  data: RateLimitInfo | null,
  colors: WidgetContext['colors'],
): string {
  if (!data) return '';
  const bar = progressBar(data.percent, barWidth, getUsageColor);
  const color = data.percent >= 90 ? uiRgb(255, 80, 80)
    : data.percent >= 75 ? uiRgb(200, 100, 255)
    : uiRgb(100, 150, 255);
  const reset = data.resetsIn ? ` ${colors.blush}~${data.resetsIn}${RESET}` : '';
  const pace = renderPaceDelta(data.paceDelta);
  return `${dimAnsi(colors.accent)}${label}${RESET} ${bar} ${color}${data.percent}%${RESET}${pace}${reset}`;
}

/** 5-hour rate limit widget */
export const rateLimit5hWidget: Widget = {
  id: 'rateLimit5h',
  render(ctx) {
    return renderRateLimit('5h', 4, ctx.fiveHourUsage, ctx.colors);
  },
};

/** 7-day rate limit widget — leads with the model-scoped weekly (e.g. Fable) when known */
export const rateLimit7dWidget: Widget = {
  id: 'rateLimit7d',
  render(ctx) {
    const scoped = ctx.modelScopedUsage;
    if (!scoped) return renderRateLimit('\u{1F4C5} 7d', 4, ctx.sevenDayUsage, ctx.colors);
    const model = renderRateLimit(`\u{1F4C5} ${scoped.label}`, 4,
      { percent: scoped.percent, resetsIn: null, paceDelta: null }, ctx.colors);
    const seven = renderRateLimit('7d', 4, ctx.sevenDayUsage, ctx.colors);
    return seven ? `${model} ${seven}` : model;
  },
};
