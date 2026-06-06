import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const CARDS = [
  {
    num: '01',
    title: 'TOKEN PRICE ADVANTAGE',
    lines: [
      'Rewards paid in HDX platform token',
      'Early price is low — more tokens per $1',
      'Benefits compound as adoption grows',
      'TWAP oracle protects against manipulation',
    ],
    delay: 80,
  },
  {
    num: '02',
    title: 'REACH STREAK 3 SOONER',
    lines: [
      'Maximum streak in 3 restake cycles',
      '90-day lock → Streak 3 in under a year',
      'Highest bonus rate locked in early',
      'Every cycle earns while building streak',
    ],
    delay: 170,
  },
  {
    num: '03',
    title: 'NETWORK DEPTH COMPOUNDS',
    lines: [
      'Early referrals build deeper network',
      'Downline ROI streams start from Day 1',
      '10 levels, every lock, every second',
      'Your network earns for you 24/7',
    ],
    delay: 260,
  },
];

export const Scene09EarlyMover: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [1140, 1200], [1, 0], cl);

  const curveProgress = interpolate(Math.max(0, frame - 130), [0, 200], [0, 1], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity:interpolate(frame,[0,18],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:68,letterSpacing:5,color:C.gold,margin:0}}>EARLY MOVER ADVANTAGES</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          Time in the Protocol Earns on All Four Streams Simultaneously
        </p>
      </div>

      <div style={{
        position:'absolute', top:190, left:'50%', transform:'translateX(-50%)',
        display:'flex', gap:36, alignItems:'flex-start',
      }}>
        {CARDS.map(({num, title, lines, delay}, i) => {
          const cf = Math.max(0, frame - delay);
          const op = interpolate(cf, [0, 18], [0, 1], cl);
          const ty = spring({frame: cf, fps, from: 55, to: 0, config: {damping: 200}});
          return (
            <div key={i} style={{
              opacity: op, transform: `translateY(${ty}px)`,
              width: 520, backgroundColor: C.panel,
              border: `1px solid ${C.border}`,
              borderRadius: 4, overflow: 'hidden',
            }}>
              {/* Gold top bar */}
              <div style={{
                height: 3,
                background: `linear-gradient(90deg, ${C.gold}, transparent)`,
              }} />
              <div style={{padding: '28px 30px'}}>
                <div style={{display:'flex',alignItems:'baseline',gap:14,marginBottom:18}}>
                  <span style={{fontFamily:MONO,fontSize:11,letterSpacing:3,color:C.muted}}>{num}</span>
                  <h3 style={{fontFamily:DISPLAY,fontSize:24,letterSpacing:3,color:C.gold,margin:0}}>{title}</h3>
                </div>
                {lines.map((line, li) => {
                  const lf = Math.max(0, frame - (delay + 30 + li * 18));
                  return (
                    <div key={li} style={{
                      display:'flex', alignItems:'flex-start', gap:12, marginBottom:14,
                      opacity: interpolate(lf,[0,14],[0,1],cl),
                    }}>
                      <span style={{color:C.gold,fontFamily:MONO,fontSize:14,lineHeight:'26px',flexShrink:0}}>→</span>
                      <p style={{fontFamily:MONO,fontSize:16,color:C.text,margin:0,lineHeight:1.6}}>{line}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* HDX token price curve */}
      <svg style={{position:'absolute',bottom:36,left:'50%',transform:'translateX(-50%)'}}
        viewBox="0 0 1000 110" width={1000} height={110}>
        {(() => {
          const pf = Math.max(0, frame - 420);
          const op = interpolate(pf, [0, 18], [0, 1], cl);
          const PTS: [number,number][] = [[0,90],[100,86],[220,74],[360,58],[500,40],[640,24],[780,12],[900,5],[980,2]];
          const maxI = Math.min(PTS.length - 1, Math.floor(curveProgress * PTS.length));
          const vis = PTS.slice(0, maxI + 1);
          return (
            <g opacity={op}>
              <text x={500} y={16} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={3}>
                HDX TOKEN PRICE TRAJECTORY (ILLUSTRATIVE)
              </text>
              {vis.length > 1 && (
                <>
                  <path
                    d={`M${vis[0][0]},${vis[0][1]} ${vis.slice(1).map(p=>`L${p[0]},${p[1]}`).join(' ')}`}
                    fill="none" stroke={C.gold} strokeWidth={2.5}
                    strokeLinecap="round" strokeLinejoin="round" />
                  <path
                    d={`M${vis[0][0]},${vis[0][1]} ${vis.slice(1).map(p=>`L${p[0]},${p[1]}`).join(' ')} L${vis[vis.length-1][0]},100 L0,100 Z`}
                    fill={C.gold} opacity={0.06} />
                </>
              )}
              <text x={4} y={106} fill={C.muted} fontFamily={MONO} fontSize={10}>LAUNCH</text>
              <text x={952} y={106} fill={C.gold} fontFamily={MONO} fontSize={10} letterSpacing={1}>GROWTH →</text>
            </g>
          );
        })()}
      </svg>
    </AbsoluteFill>
  );
};
