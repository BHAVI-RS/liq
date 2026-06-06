import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const STREAKS = [
  {badge: 'S0', bonus: 'Base Rate',  rate: '174%', reward: '$8,700',  delay: 80,  gold: false},
  {badge: 'S1', bonus: '+10% Bonus', rate: '184%', reward: '$9,200',  delay: 130, gold: false},
  {badge: 'S2', bonus: '+20% Bonus', rate: '194%', reward: '$9,700',  delay: 180, gold: false},
  {badge: 'S3', bonus: '+30% Bonus', rate: '204%', reward: '$10,200', delay: 230, gold: true},
];

export const Scene05Streak: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [1170, 1230], [1, 0], cl);

  const counterVal = interpolate(Math.max(0, frame - 350), [0, 120], [8700, 10200], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity: interpolate(frame,[0,18],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:70,letterSpacing:6,color:C.gold,margin:0}}>THE STREAK SYSTEM</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          Consecutive Restakes Build Your Bonus Multiplier
        </p>
      </div>

      {/* Example label */}
      <div style={{position:'absolute',top:185,left:'50%',transform:'translateX(-50%)',
        opacity: interpolate(Math.max(0,frame-40),[0,18],[0,1],cl), textAlign:'center'}}>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:3,color:C.muted,margin:0,textTransform:'uppercase'}}>
          Example: $5,000 Investment · 360-Day Lock
        </p>
      </div>

      <div style={{
        position:'absolute', top:238, left:'50%', transform:'translateX(-50%)',
        display:'flex', gap:32, alignItems:'flex-start',
      }}>
        {STREAKS.map(({badge, bonus, rate, reward, delay, gold}, i) => {
          const sf = Math.max(0, frame - delay);
          const op = interpolate(sf, [0, 18], [0, 1], cl);
          const ty = spring({frame: sf, fps, from: 50, to: 0, config: {damping: 200}});
          const isAnimating = gold && frame > 350;
          return (
            <div key={i} style={{
              opacity: op, transform: `translateY(${ty}px)`, width: 370, position: 'relative',
            }}>
              {/* Arrow between cards */}
              {i < 3 && (
                <div style={{
                  position:'absolute', right:-28, top:'50%', transform:'translateY(-50%)',
                  opacity: interpolate(Math.max(0,frame-(delay+45)),[0,14],[0,1],cl),
                  zIndex:10,
                }}>
                  <svg viewBox="0 0 20 20" width={20} height={20}>
                    <polygon points="2,4 18,10 2,16" fill={C.gold} opacity={0.6} />
                  </svg>
                </div>
              )}
              <div style={{
                backgroundColor: gold ? 'rgba(201,168,76,0.08)' : C.panel,
                border: `1px solid ${gold ? 'rgba(201,168,76,0.35)' : C.border}`,
                borderRadius: 4, padding: '32px 24px', textAlign: 'center',
                boxShadow: gold ? `0 0 40px rgba(201,168,76,0.12)` : 'none',
              }}>
                {/* Badge circle */}
                <div style={{
                  width: 64, height: 64, borderRadius: '50%', margin: '0 auto 18px',
                  backgroundColor: gold ? C.gold : C.border,
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <span style={{fontFamily:DISPLAY,fontSize:28,letterSpacing:2,color: gold ? C.bg : C.muted}}>
                    {badge}
                  </span>
                </div>
                <p style={{fontFamily:DISPLAY,fontSize:48,letterSpacing:3,
                  color: gold ? C.gold : C.cream, margin:'0 0 4px'}}>
                  {rate}
                </p>
                <p style={{fontFamily:MONO,fontSize:12,letterSpacing:2,
                  color: gold ? C.gold2 : C.muted, margin:'0 0 22px', textTransform:'uppercase'}}>
                  {bonus}
                </p>
                <div style={{borderTop:`1px solid ${C.border}`,paddingTop:18}}>
                  <p style={{fontFamily:MONO,fontSize:11,letterSpacing:2,color:C.muted,margin:'0 0 6px',textTransform:'uppercase'}}>
                    Annual Reward
                  </p>
                  <p style={{fontFamily:DISPLAY,fontSize: gold ? 38 : 30,letterSpacing:2,
                    color: gold ? C.gold : C.cream, margin:0}}>
                    {isAnimating ? `$${Math.round(counterVal).toLocaleString()}` : reward}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      {(() => {
        const nf = Math.max(0, frame - 500);
        return (
          <div style={{
            position:'absolute', bottom:72, left:'50%', transform:'translateX(-50%)',
            opacity: interpolate(nf,[0,20],[0,1],cl), textAlign:'center',
          }}>
            <p style={{fontFamily:MONO,fontSize:13,color:C.text,margin:0}}>
              Switch duration or miss a cycle →{' '}
              <span style={{color:C.gold}}>streak resets to S0</span>
            </p>
            <p style={{fontFamily:MONO,fontSize:11,color:C.muted,margin:'8px 0 0',letterSpacing:1}}>
              Reach Streak 3 in just 3 consecutive restake cycles
            </p>
          </div>
        );
      })()}
    </AbsoluteFill>
  );
};
