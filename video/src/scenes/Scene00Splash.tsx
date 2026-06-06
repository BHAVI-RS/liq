import React from 'react';
import {AbsoluteFill, useCurrentFrame, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

export const Scene00Splash: React.FC = () => {
  const frame = useCurrentFrame();

  // Dark → bright: overall bg lightens slightly then settles
  const bgBrightness = interpolate(frame, [0, 45, 90], [0, 0.06, 0], cl);

  // Glow orb expands from nothing to full
  const glowSize = interpolate(frame, [0, 60], [0, 1], cl);
  const glowOpacity = interpolate(frame, [0, 30, 75, 90], [0, 0.18, 0.12, 0.1], cl);

  // Logo: starts completely invisible, slowly brightens (dark→bright transition)
  const logoOpacity = interpolate(frame, [8, 55], [0, 1], cl);
  // Additional glow burst at peak brightness
  const logoGlow = interpolate(frame, [30, 60, 75], [0, 1, 0.7], cl);

  // Subtitle fades in after logo appears
  const subOpacity = interpolate(frame, [45, 70], [0, 1], cl);

  // Thin gold line under logo draws in
  const lineWidth = interpolate(frame, [50, 75], [0, 320], cl);
  const lineOpacity = interpolate(frame, [50, 65], [0, 1], cl);

  // Scan line effect during reveal (moves top to bottom)
  const scanY = interpolate(frame, [8, 52], [-10, 110], cl);
  const scanOpacity = interpolate(frame, [8, 20, 48, 55], [0, 0.6, 0.6, 0], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg}}>
      {/* Extra brightness flash during reveal */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none',
        backgroundColor: `rgba(201,168,76,${bgBrightness})`,
      }} />

      {/* Central glow expands as logo appears */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 1200 * glowSize, height: 700 * glowSize,
        background: `radial-gradient(ellipse, rgba(201,168,76,${glowOpacity}) 0%, transparent 65%)`,
        pointerEvents: 'none',
      }} />

      {/* Scan line sweeping down */}
      <div style={{
        position: 'absolute', left: 0, right: 0,
        top: `${scanY}%`, height: 2,
        background: `linear-gradient(90deg, transparent, rgba(201,168,76,${scanOpacity}), transparent)`,
        pointerEvents: 'none',
      }} />

      {/* HORDEX logo */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -55%)',
        opacity: logoOpacity, textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: DISPLAY,
          fontSize: 200,
          letterSpacing: 20,
          color: C.gold,
          margin: 0,
          lineHeight: 1,
          textShadow: [
            `0 0 ${120 * logoGlow}px rgba(201,168,76,${0.7 * logoGlow})`,
            `0 0 ${240 * logoGlow}px rgba(201,168,76,${0.35 * logoGlow})`,
            `0 0 ${400 * logoGlow}px rgba(201,168,76,${0.15 * logoGlow})`,
          ].join(', '),
        }}>
          HORDEX
        </h1>
      </div>

      {/* Divider line */}
      <div style={{
        position: 'absolute', top: '56%', left: '50%',
        transform: 'translateX(-50%)',
        width: lineWidth, height: 1,
        backgroundColor: C.gold, opacity: lineOpacity * 0.5,
      }} />

      {/* Tagline */}
      <div style={{
        position: 'absolute', top: '60%', left: '50%',
        transform: 'translateX(-50%)',
        opacity: subOpacity, textAlign: 'center', whiteSpace: 'nowrap',
      }}>
        <p style={{
          fontFamily: MONO, fontSize: 18,
          letterSpacing: 6, color: C.muted,
          textTransform: 'uppercase', margin: 0,
        }}>
          — &nbsp; Funding the Future &nbsp; —
        </p>
      </div>
    </AbsoluteFill>
  );
};
