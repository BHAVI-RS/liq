import React from 'react';
import {AbsoluteFill, useCurrentFrame, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const WORDS = "What if a single investment could simultaneously earn you trading fees, staking rewards, referral commissions, and passive income from every person you bring onboard — all at once, automatically, with no middleman?".split(' ');
const GOLD_SET = new Set(['fees,', 'rewards,', 'commissions,', 'income']);

export const Scene01Hook: React.FC = () => {
  const frame = useCurrentFrame();

  const fadeIn  = interpolate(frame, [0, 18], [0, 1], cl);
  const fadeOut = interpolate(frame, [340, 390], [1, 0], cl);

  // Central glow pulses gently
  const glowPulse = 0.07 + 0.03 * Math.sin(frame * 0.04);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeIn * fadeOut}}>
      {/* Glow behind text */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 1100, height: 600,
        background: `radial-gradient(ellipse, rgba(201,168,76,${glowPulse}) 0%, transparent 70%)`,
        pointerEvents: 'none',
      }} />

      {/* Label */}
      <div style={{
        position: 'absolute', top: 160, left: '50%', transform: 'translateX(-50%)',
        opacity: interpolate(frame, [0, 25], [0, 1], cl),
      }}>
        <p style={{
          fontFamily: MONO, fontSize: 12, letterSpacing: 4,
          color: C.gold, textTransform: 'uppercase', margin: 0, textAlign: 'center',
        }}>
          The Question
        </p>
      </div>

      {/* Question text — word-by-word reveal */}
      <div style={{
        position: 'absolute', top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 1380, textAlign: 'center', marginTop: 30,
      }}>
        <p style={{
          fontFamily: MONO, fontSize: 34,
          color: C.cream, lineHeight: 1.8, margin: 0,
          fontWeight: 400, letterSpacing: 0.3,
        }}>
          {WORDS.map((word, i) => {
            const wf = Math.max(0, frame - (10 + i * 5));
            const op = interpolate(wf, [0, 10], [0, 1], cl);
            const isGold = GOLD_SET.has(word);
            return (
              <React.Fragment key={i}>
                <span style={{
                  opacity: op,
                  color: isGold ? C.gold2 : C.cream,
                  fontWeight: isGold ? 500 : 400,
                }}>
                  {word}
                </span>{' '}
              </React.Fragment>
            );
          })}
        </p>
      </div>
    </AbsoluteFill>
  );
};
