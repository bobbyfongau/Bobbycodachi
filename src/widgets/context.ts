import { RESET, DIM, uiRgb, progressBar, getContextColor } from '../render/colors.js';
import type { Widget } from './types.js';

/** Context usage widget: [======----] 55% 555K/1.0M */
export const contextWidget: Widget = {
  id: 'context',
  render(ctx) {
    const { contextPercent, tokenSummary } = ctx;
    const bar = progressBar(contextPercent, 4, getContextColor);
    const color = contextPercent >= 85 ? uiRgb(255, 80, 80)
      : contextPercent >= 70 ? uiRgb(255, 200, 50) : uiRgb(80, 220, 120);
    let out = `${bar} ${color}${contextPercent}%${RESET}`;
    if (tokenSummary) out += ` ${DIM}${tokenSummary}${RESET}`;
    return out;
  },
};
