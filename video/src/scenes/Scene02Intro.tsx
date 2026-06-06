import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const BADGES = [
  {label: 'BUILT ON UNISWAP V2', delay: 130},
  {label: 'BINANCE SMART CHAIN', delay: 160},
  {label: 'NON-CUSTODIAL', delay: 190},
  {label: 'PERMISSIONLESS', delay: 220},
];

export const Scene02Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fadeIn  = interpolate(frame, [0, 20], [0, 1], cl);
  const fadeOut = interpolate(frame, [720, 780], [1, 0], cl);

  // Orbital ring rotation
  const rot = frame * 0.25;

  const logoY  = spring({frame, fps, from: 50, to: 0, config: {damping: 200, stiffness: 70}});
  const logoOp = interpolate(frame, [0, 28], [0, 1], cl);

  const subY  = spring({frame: Math.max(0, frame - 40), fps, from: 30, to: 0, config: {damping: 200}});
  const subOp = interpolate(Math.max(0, frame - 40), [0, 20], [0, 1], cl);

  const ringScale = spring({frame, fps, from: 0.3, to: 1, config: {damping: 80, stiffness: 30}});

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeIn * fadeOut}}>
      {/* Orbital rings SVG */}
      <svg style={{position: 'absolute', inset: 0, width: '100%', height: '100%'}} viewBox="0 0 1920 1080">
        <g transform="translate(960,490)">
          <ellipse cx={0} cy={0} rx={380 * ringScale} ry={380 * ringScale}
            stroke={C.gold} strokeWidth={1} fill="none" opacity={0.14}
            transform={`rotate(${rot})`} strokeDasharray="8 18" />
          <ellipse cx={0} cy={0} rx={520 * ringScale} ry={520 * ringScale}
            stroke={C.gold} strokeWidth={0.7} fill="none" opacity={0.08}
            transform={`rotate(${-rot * 0.65})`} strokeDasharray="5 24" />
          <ellipse cx={0} cy={0} rx={280 * ringScale} ry={280 * ringScale}
            stroke={C.gold2} strokeWidth={1.2} fill="none" opacity={0.1}
            transform={`rotate(${rot * 1.4})`} strokeDasharray="10 12" />
          {/* Central glow disc */}
          <radialGradient id="cgd2" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={C.gold} stopOpacity="0.1" />
            <stop offset="100%" stopColor={C.bg} stopOpacity="0" />
          </radialGradient>
          <circle cx={0} cy={0} r={260 * ringScale} fill="url(#cgd2)" />
        </g>
      </svg>

      {/* HORDEX wordmark */}
      <div style={{
        position: 'absolute', top: '36%', left: '50%',
        transform: `translate(-50%, calc(-50% + ${logoY}px))`,
        opacity: logoOp, textAlign: 'center',
      }}>
        <h1 style={{
          fontFamily: DISPLAY, fontSize: 148, letterSpacing: 16,
          color: C.gold, margin: 0, lineHeight: 1,
          textShadow: `0 0 80px rgba(201,168,76,0.3), 0 0 160px rgba(201,168,76,0.12)`,
        }}>
          HORDEX
        </h1>
      </div>

      {/* Subtitle */}
      <div style={{
        position: 'absolute', top: '57%', left: '50%',
        transform: `translate(-50%, calc(-50% + ${subY}px))`,
        opacity: subOp, textAlign: 'center',
      }}>
        <p style={{fontFamily: MONO, fontSize: 16, letterSpacing: 6, color: C.muted, margin: 0, textTransform: 'uppercase'}}>
          Decentralized Liquidity Protocol
        </p>
        <div style={{width: 200, height: 1, background: C.gold, opacity: 0.3, margin: '16px auto'}} />
        <p style={{fontFamily: MONO, fontSize: 12, letterSpacing: 4, color: C.muted, margin: 0}}>
          — &nbsp; Funding the Future &nbsp; —
        </p>
      </div>

      {/* Feature badges */}
      <div style={{
        position: 'absolute', bottom: 100, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 20,
      }}>
        {BADGES.map(({label, delay}, i) => {
          const bf = Math.max(0, frame - delay);
          const bop = interpolate(bf, [0, 18], [0, 1], cl);
          const by = spring({frame: bf, fps, from: 24, to: 0, config: {damping: 200}});
          return (
            <div key={i} style={{
              opacity: bop, transform: `translateY(${by}px)`,
              backgroundColor: C.panel,
              border: `1px solid rgba(201,168,76,0.18)`,
              borderRadius: 4, padding: '10px 26px',
            }}>
              <span style={{fontFamily: MONO, fontSize: 11, letterSpacing: 2, color: C.gold}}>
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
