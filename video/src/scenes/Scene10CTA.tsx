import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

export const Scene10CTA: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const fadeIn = interpolate(frame, [0, 18], [0, 1], cl);

  const logoScale = spring({frame, fps, from: 0.5, to: 1, config: {damping: 120, stiffness: 50}});
  const logoOp = interpolate(frame, [0, 22], [0, 1], cl);
  const logoGlow = interpolate(frame, [0, 35], [0, 1], cl);

  const lineW  = interpolate(Math.max(0, frame - 35), [0, 30], [0, 350], cl);
  const lineOp = interpolate(Math.max(0, frame - 35), [0, 18], [0, 1], cl);

  const subOp = interpolate(Math.max(0, frame - 55), [0, 18], [0, 1], cl);
  const subY  = spring({frame: Math.max(0, frame - 55), fps, from: 22, to: 0, config: {damping: 200}});

  const ctaOp = interpolate(Math.max(0, frame - 130), [0, 18], [0, 1], cl);
  const ctaY  = spring({frame: Math.max(0, frame - 130), fps, from: 22, to: 0, config: {damping: 200}});

  // Button pulse
  const pulse = 0.96 + 0.04 * Math.abs(Math.sin(frame * 0.1));

  // Rotating particle ring
  const ringRot = frame * 0.4;

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeIn}}>
      {/* Radial glow */}
      <div style={{
        position:'absolute', top:'50%', left:'50%',
        transform:'translate(-50%, -50%)',
        width: 900, height: 600,
        background:`radial-gradient(ellipse, rgba(201,168,76,${0.1 * logoGlow}) 0%, transparent 65%)`,
        pointerEvents:'none',
      }} />

      {/* Particle orbit ring */}
      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {Array.from({length: 22}, (_, i) => {
          const angle = (i / 22) * Math.PI * 2 + ringRot * Math.PI / 180;
          const r = 380 + 20 * Math.sin(frame * 0.05 + i);
          const x = 960 + r * Math.cos(angle);
          const y = 520 + r * Math.sin(angle);
          const op = (0.08 + 0.08 * Math.abs(Math.sin(frame * 0.04 + i))) * logoGlow;
          return <circle key={i} cx={x} cy={y} r={2.5} fill={C.gold} opacity={op} />;
        })}
      </svg>

      {/* HORDEX logo */}
      <div style={{
        position:'absolute', top:'38%', left:'50%',
        transform:`translate(-50%, -50%) scale(${logoScale})`,
        opacity: logoOp, textAlign:'center',
      }}>
        <h1 style={{
          fontFamily: DISPLAY,
          fontSize: 190, letterSpacing: 18, color: C.gold, margin: 0, lineHeight: 1,
          textShadow: [
            `0 0 ${80 * logoGlow}px rgba(201,168,76,0.6)`,
            `0 0 ${160 * logoGlow}px rgba(201,168,76,0.3)`,
            `0 0 ${320 * logoGlow}px rgba(201,168,76,0.12)`,
          ].join(', '),
        }}>
          HORDEX
        </h1>
      </div>

      {/* Divider line */}
      <div style={{
        position:'absolute', top:'56%', left:'50%',
        transform:'translateX(-50%)',
        width: lineW, height: 1,
        background: `linear-gradient(90deg, transparent, ${C.gold}, transparent)`,
        opacity: lineOp * 0.5,
      }} />

      {/* Tagline */}
      <div style={{
        position:'absolute', top:'62%', left:'50%',
        transform:`translate(-50%, calc(-50% + ${subY}px))`,
        opacity: subOp, textAlign:'center', whiteSpace:'nowrap',
      }}>
        <p style={{fontFamily:MONO, fontSize:14, letterSpacing:5, color:C.muted, margin:0}}>
          DECENTRALIZED &nbsp;·&nbsp; TRANSPARENT &nbsp;·&nbsp; REWARDING
        </p>
      </div>

      {/* CTA */}
      <div style={{
        position:'absolute', top:'74%', left:'50%',
        transform:`translate(-50%, calc(-50% + ${ctaY}px))`,
        opacity: ctaOp, textAlign:'center',
      }}>
        <p style={{fontFamily:MONO,fontSize:14,color:C.muted,margin:'0 0 24px',letterSpacing:2}}>
          The best time to start was yesterday.
        </p>
        <div style={{
          display:'inline-block',
          backgroundColor: C.gold,
          borderRadius: 2,
          padding: '20px 72px',
          transform: `scale(${pulse})`,
          boxShadow: `0 0 ${40 * pulse}px rgba(201,168,76,0.4)`,
        }}>
          <span style={{
            fontFamily:DISPLAY, fontSize:28,
            letterSpacing:5, color:C.bg,
          }}>
            CONNECT YOUR WALLET TODAY
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
