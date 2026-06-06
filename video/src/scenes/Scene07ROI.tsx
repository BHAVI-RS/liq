import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const ROWS = [
  {label:'Level 1 (You)', pct:'10%', usd:'$100', main:true, delay:100},
  {label:'Level 2',       pct:'5%',  usd:'$50',  main:false, delay:130},
  {label:'Level 3',       pct:'2%',  usd:'$20',  main:false, delay:158},
  {label:'Level 4',       pct:'1%',  usd:'$10',  main:false, delay:186},
  {label:'Level 5',       pct:'0.5%',usd:'$5',   main:false, delay:214},
  {label:'Levels 6–10',   pct:'0.25% each',usd:'$2.50 each',main:false,delay:242},
];

export const Scene07ROI: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [1500, 1560], [1, 0], cl);

  const staking = interpolate(Math.max(0, frame - 200), [0, 280], [0, 1000], cl);
  const roi     = interpolate(Math.max(0, frame - 200), [0, 280], [0, 200], cl);

  // Animated stream bead position
  const beadY = 880 - (((frame - 180) % 100 + 100) % 100) * 6.8;
  const beadOp = frame > 180 ? interpolate(((frame - 180) % 100 + 100) % 100, [0, 10, 85, 100], [0, 1, 1, 0], cl) : 0;

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity:interpolate(frame,[0,18],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:66,letterSpacing:5,color:C.gold,margin:0}}>ROI COMMISSION STREAMS</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          20% of Downline Staking Rewards · Streams Every Second · 10 Levels Deep
        </p>
      </div>

      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {/* Left: downline earner panel */}
        {(() => {
          const pf = Math.max(0, frame - 38);
          const op = interpolate(pf, [0, 20], [0, 1], cl);
          return (
            <g opacity={op}>
              <rect x={80} y={165} width={480} height={810} rx={4}
                fill={C.panel} stroke={C.border} strokeWidth={1} />
              <text x={320} y={220} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={3}>DOWNLINE EARNER</text>

              {/* User avatar */}
              <circle cx={320} cy={310} r={52} fill={C.border} />
              <text x={320} y={305} textAnchor="middle" fill={C.text} fontFamily={DISPLAY} fontSize={22} letterSpacing={2}>USER</text>
              <text x={320} y={328} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={12}>90-day lock</text>

              {/* Staking accumulating */}
              <text x={320} y={415} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={12} letterSpacing={1}>STAKING REWARD ACCRUING</text>
              <text x={320} y={465} textAnchor="middle" fill={C.cream} fontFamily={DISPLAY} fontSize={46} letterSpacing={2}>
                ${Math.round(staking).toLocaleString()}
              </text>
              <text x={320} y={494} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={12}>of $1,000 total</text>

              {/* Progress bar */}
              <rect x={118} y={514} width={404} height={10} rx={5} fill={C.border} />
              <rect x={118} y={514} width={404 * staking / 1000} height={10} rx={5} fill={C.gold} />

              {/* Divider */}
              <line x1={100} y1={550} x2={540} y2={550} stroke={C.border} strokeWidth={1} />

              <text x={320} y={594} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={12} letterSpacing={2}>
                20% ROI FLOWING UPSTREAM
              </text>
              <text x={320} y={648} textAnchor="middle" fill={C.gold} fontFamily={DISPLAY} fontSize={52} letterSpacing={2}>
                ${Math.round(roi).toLocaleString()}
              </text>
              <text x={320} y={678} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={12}>of $200 total ROI</text>

              {/* Live indicator */}
              <circle cx={290} cy={730} r={5 + 3 * Math.abs(Math.sin(frame * 0.1))} fill={C.success} opacity={0.8} />
              <text x={310} y={736} fill={C.success} fontFamily={MONO} fontSize={14} letterSpacing={1}>LIVE STREAM</text>

              {/* Claim note */}
              <rect x={100} y={780} width={420} height={76} rx={4} fill={C.surface} stroke={C.border} strokeWidth={1} />
              <text x={310} y={820} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={0.5}>
                Claimable anytime
              </text>
              <text x={310} y={843} textAnchor="middle" fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={0.5}>
                Paid in platform tokens at live TWAP
              </text>
            </g>
          );
        })()}

        {/* Animated stream bead */}
        {frame > 180 && (
          <g>
            <line x1={592} y1={160} x2={592} y2={900}
              stroke={C.border} strokeWidth={1} strokeDasharray="3 9" opacity={0.3} />
            <circle cx={592} cy={beadY} r={9} fill={C.gold} opacity={beadOp * 0.9} />
            <circle cx={592} cy={beadY} r={18} fill={C.gold} opacity={beadOp * 0.15} />
          </g>
        )}

        {/* Right: level rows */}
        {ROWS.map(({label, pct, usd, main, delay}, i) => {
          const rf = Math.max(0, frame - delay);
          const op = interpolate(rf, [0, 18], [0, 1], cl);
          const tx = spring({frame: rf, fps, from: -50, to: 0, config: {damping: 200}});
          const ry = 160 + i * 118;
          return (
            <g key={i} opacity={op} transform={`translate(${tx},0)`}>
              <rect x={660} y={ry} width={1200} height={100} rx={4}
                fill={main ? 'rgba(201,168,76,0.07)' : C.panel}
                stroke={main ? `rgba(201,168,76,0.28)` : C.border}
                strokeWidth={main ? 1.2 : 1} />
              <text x={700} y={ry+55}
                fill={main ? C.gold2 : C.cream}
                fontFamily={DISPLAY} fontSize={main ? 28 : 22} letterSpacing={3}>
                {label.toUpperCase()}
              </text>
              <text x={1220} y={ry+55} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={13} letterSpacing={1}>{pct} of reward</text>
              <text x={1836} y={ry+55} textAnchor="end"
                fill={main ? C.gold : C.text}
                fontFamily={main ? DISPLAY : MONO}
                fontSize={main ? 34 : 24}
                letterSpacing={main ? 2 : 0.5}>
                {main ? `$${Math.round(roi / 10).toFixed(0)}` : usd}
              </text>
              {main && frame > 200 && (
                <circle cx={1856} cy={ry+42}
                  r={5 + 2 * Math.abs(Math.sin(frame * 0.12))}
                  fill={C.success} opacity={0.85} />
              )}
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
