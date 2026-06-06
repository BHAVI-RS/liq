import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const RINGS = [
  {r: 170, nodes: 3, delay: 60},
  {r: 300, nodes: 5, delay: 108},
  {r: 420, nodes: 7, delay: 152},
  {r: 520, nodes: 8, delay: 192},
];
const LEVELS = [
  {label:'L1', pct:'10%', usd:'$500',  main:true,  delay:200},
  {label:'L2', pct:'5%',  usd:'$250',  main:false, delay:228},
  {label:'L3', pct:'2%',  usd:'$100',  main:false, delay:256},
  {label:'L4', pct:'1%',  usd:'$50',   main:false, delay:284},
  {label:'L5', pct:'0.5%',usd:'$25',   main:false, delay:312},
  {label:'L6–10',pct:'0.25% each',usd:'$12.50 each',main:false,delay:340},
];

const CX = 520, CY = 570;

export const Scene06Referral: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [1530, 1590], [1, 0], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity: interpolate(frame,[0,18],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:66,letterSpacing:5,color:C.gold,margin:0}}>REFERRAL COMMISSION SYSTEM</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          20% of Investment · Paid Instantly In USDT · 10 Levels Deep
        </p>
      </div>

      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {/* Expanding rings */}
        {RINGS.map(({r, nodes, delay}, ri) => {
          const rf = Math.max(0, frame - delay);
          const sc = spring({frame: rf, fps, from: 0, to: 1, config: {damping: 160, stiffness: 55}});
          const op = interpolate(rf, [0, 20], [0, 1], cl);
          return (
            <g key={ri}>
              <circle cx={CX} cy={CY} r={r * sc}
                stroke={C.gold} strokeWidth={0.7} fill="none"
                opacity={0.12 - ri * 0.02} strokeDasharray="5 14" />
              {Array.from({length: nodes}, (_, ni) => {
                const angle = (ni / nodes) * Math.PI * 2 + ri * 0.4;
                const nx = CX + r * Math.cos(angle);
                const ny = CY + r * Math.sin(angle);
                const lx = CX + r * sc * Math.cos(angle);
                const ly = CY + r * sc * Math.sin(angle);
                return (
                  <g key={ni} opacity={op}>
                    <line x1={CX} y1={CY} x2={lx} y2={ly}
                      stroke={C.gold} strokeWidth={0.5} opacity={0.15} />
                    <circle cx={lx} cy={ly} r={ri === 0 ? 9 : 6}
                      fill={ri === 0 ? C.gold : C.panel}
                      stroke={ri === 0 ? 'none' : `rgba(201,168,76,0.3)`} strokeWidth={1} />
                  </g>
                );
              })}
              {/* Ring label */}
              <text x={CX + r * sc + 14} y={CY + 5} fill={C.gold}
                fontFamily={MONO} fontSize={14} letterSpacing={1}
                opacity={interpolate(Math.max(0,frame-(delay+25)),[0,16],[0,1],cl)}>
                L{ri+1}
              </text>
            </g>
          );
        })}

        {/* Center node */}
        {(() => {
          const sc = spring({frame, fps, from: 0, to: 1, config: {damping: 150}});
          return (
            <g>
              <circle cx={CX} cy={CY} r={55 * sc} fill={C.gold} />
              <text x={CX} y={CY - 8} textAnchor="middle"
                fill={C.bg} fontFamily={DISPLAY} fontSize={22} letterSpacing={3}>YOU</text>
              <text x={CX} y={CY + 14} textAnchor="middle"
                fill='rgba(4,8,15,0.55)' fontFamily={MONO} fontSize={12} letterSpacing={1}>Investor</text>
            </g>
          );
        })()}

        {/* Animated gold drops flowing upward */}
        {frame > 400 && [0, 1, 2, 3].map(i => {
          const df = (frame - 400 + i * 22) % 88;
          const dy = CY - df * 3.8;
          const dop = interpolate(df, [0, 18, 72, 88], [0, 1, 1, 0], cl);
          return (
            <g key={i}>
              <circle cx={CX + [-28,-8,8,28][i]} cy={dy} r={4.5}
                fill={C.gold} opacity={dop * 0.75} />
              <circle cx={CX + [-28,-8,8,28][i]} cy={dy} r={9}
                fill={C.gold} opacity={dop * 0.12} />
            </g>
          );
        })}

        {/* Commission table panel */}
        {(() => {
          const pf = Math.max(0, frame - 130);
          const pop = interpolate(pf, [0, 20], [0, 1], cl);
          const py = spring({frame: pf, fps, from: 40, to: 0, config: {damping: 200}});
          return (
            <g opacity={pop} transform={`translate(0,${py})`}>
              <rect x={1120} y={160} width={750} height={790} rx={4}
                fill={C.panel} stroke={C.border} strokeWidth={1} />
              <text x={1495} y={218} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={26} letterSpacing={4}>
                $5,000 INVESTMENT
              </text>
              <text x={1495} y={246} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={2}>
                COMMISSION BREAKDOWN · 20% = $1,000 TOTAL
              </text>
              <line x1={1138} y1={262} x2={1852} y2={262} stroke={C.border} strokeWidth={1} />

              {LEVELS.map(({label, pct, usd, main, delay}, i) => {
                const rf = Math.max(0, frame - delay);
                const op = interpolate(rf, [0, 16], [0, 1], cl);
                const ry = 278 + i * 88;
                return (
                  <g key={i} opacity={op}>
                    {main && (
                      <rect x={1128} y={ry} width={736} height={82} rx={3}
                        fill={C.gold} opacity={0.06} />
                    )}
                    <text x={1158} y={ry + 46}
                      fill={main ? C.gold2 : C.cream}
                      fontFamily={DISPLAY} fontSize={main ? 28 : 22} letterSpacing={3}>
                      {label.toUpperCase()}
                    </text>
                    <text x={1560} y={ry + 46} textAnchor="middle"
                      fill={C.muted} fontFamily={MONO} fontSize={13} letterSpacing={1}>{pct}</text>
                    <text x={1842} y={ry + 46} textAnchor="end"
                      fill={main ? C.gold : C.text}
                      fontFamily={main ? DISPLAY : MONO}
                      fontSize={main ? 32 : 22}
                      letterSpacing={main ? 2 : 0.5}>{usd}</text>
                  </g>
                );
              })}

              {/* 5x cap note */}
              {(() => {
                const nf = Math.max(0, frame - 820);
                return (
                  <g opacity={interpolate(nf,[0,18],[0,1],cl)}>
                    <rect x={1138} y={810} width={726} height={52} rx={4}
                      fill={C.surface} stroke={C.border} strokeWidth={1} />
                    <text x={1500} y={842} textAnchor="middle"
                      fill={C.muted} fontFamily={MONO} fontSize={12} letterSpacing={1}>
                      5× cap per position · Skips ineligible levels
                    </text>
                  </g>
                );
              })()}
            </g>
          );
        })()}
      </svg>
    </AbsoluteFill>
  );
};
