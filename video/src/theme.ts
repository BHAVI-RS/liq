// Exact match to frontend CSS variables (base.css)
export const C = {
  bg:      '#04080f',
  surface: '#080f1a',
  panel:   '#0b1520',
  border:  '#141e2a',
  gold:    '#c9a84c',
  gold2:   '#f0d080',
  goldGlow:'rgba(201,168,76,0.12)',
  goldLine:'rgba(201,168,76,0.04)',
  cream:   '#ede8dc',
  text:    '#cdd9e5',
  muted:   '#4a6a7a',
  success: '#3ecf8e',
  warn:    '#ffb800',
};

// Bebas Neue for large display/logo — matches landing-logo and card-title
export const DISPLAY = "'Bebas Neue', sans-serif";
// DM Mono for labels, data, UI — matches font-mono in app
export const MONO = "'DM Mono', monospace";

// Grid background — exactly matches body::before in base.css
export const GRID_BG = {
  backgroundImage: `
    linear-gradient(${C.goldLine} 1px, transparent 1px),
    linear-gradient(90deg, ${C.goldLine} 1px, transparent 1px)
  `,
  backgroundSize: '60px 60px',
} as React.CSSProperties;
