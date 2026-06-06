import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const Box: React.FC<{x:number;y:number;w:number;h:number;label:string;sub?:string;gold?:boolean;frame:number;delay:number;fps:number}> =
  ({x,y,w,h,label,sub,gold,frame,delay,fps}) => {
    const f2 = Math.max(0, frame - delay);
    const op = interpolate(f2, [0, 16], [0, 1], cl);
    const sc = spring({frame: f2, fps, from: 0.8, to: 1, config: {damping: 200, stiffness: 120}});
    const cx = x + w/2, cy = y + h/2;
    return (
      <g transform={`translate(${cx},${cy}) scale(${sc}) translate(${-cx},${-cy})`} opacity={op}>
        <rect x={x} y={y} width={w} height={h} rx={4}
          fill={gold ? C.gold : C.panel}
          stroke={gold ? 'none' : `rgba(201,168,76,0.2)`} strokeWidth={1} />
        <text x={cx} y={cy + (sub ? -8 : 7)} textAnchor="middle"
          fill={gold ? C.bg : C.cream} fontFamily={DISPLAY}
          fontSize={gold ? 20 : 18} letterSpacing={2}>
          {label.toUpperCase()}
        </text>
        {sub && (
          <text x={cx} y={cy + 14} textAnchor="middle"
            fill={gold ? 'rgba(4,8,15,0.6)' : C.muted}
            fontFamily={MONO} fontSize={13} letterSpacing={1}>
            {sub}
          </text>
        )}
      </g>
    );
  };

const Arr: React.FC<{x1:number;y1:number;x2:number;y2:number;frame:number;delay:number}> =
  ({x1,y1,x2,y2,frame,delay}) => {
    const f2 = Math.max(0, frame - delay);
    const p = interpolate(f2, [0, 22], [0, 1], cl);
    const ex = x1+(x2-x1)*p, ey = y1+(y2-y1)*p;
    const op = interpolate(f2, [0, 6], [0, 1], cl);
    const angle = Math.atan2(y2-y1, x2-x1) * 180 / Math.PI;
    return (
      <g opacity={op * 0.65}>
        <line x1={x1} y1={y1} x2={ex} y2={ey} stroke={C.gold} strokeWidth={1.5} />
        {p > 0.9 && (
          <polygon points="0,-8 7,5 -7,5"
            fill={C.gold}
            transform={`translate(${ex},${ey}) rotate(${angle + 90})`} />
        )}
      </g>
    );
  };

const STREAMS = [
  {label: 'LP Trading Fees', sub: '0.3% per swap', x: 140},
  {label: 'Staking Rewards', sub: 'Fixed APY', x: 490},
  {label: 'Referral Commissions', sub: '20% of investment', x: 860},
  {label: 'ROI Commissions', sub: '20% of staking rewards', x: 1250},
];

export const Scene03HowItWorks: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeIn  = interpolate(frame, [0, 18], [0, 1], cl);
  const fadeOut = interpolate(frame, [1140, 1200], [1, 0], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeIn * fadeOut}}>
      {/* Title */}
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity: interpolate(frame,[0,20],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:68,letterSpacing:6,color:C.gold,margin:0}}>HOW HORDEX WORKS</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          One Atomic Transaction · Four Reward Streams
        </p>
      </div>

      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {/* Investment */}
        <Box x={810} y={148} w={300} h={62} label="Your Investment" sub="USDT" gold frame={frame} delay={12} fps={fps} />
        {/* Arrows to A B */}
        <Arr x1={880} y1={210} x2={700} y2={288} frame={frame} delay={35} />
        <Arr x1={1040} y1={210} x2={1220} y2={288} frame={frame} delay={35} />
        {/* A B */}
        <Box x={570} y={288} w={260} h={58} label="Side A · 50%" sub="Acquire tokens" frame={frame} delay={52} fps={fps} />
        <Box x={1090} y={288} w={260} h={58} label="Side B · 50%" sub="Stays as USDT" frame={frame} delay={52} fps={fps} />
        {/* Arrows from A */}
        <Arr x1={640} y1={346} x2={590} y2={420} frame={frame} delay={72} />
        <Arr x1={760} y1={346} x2={820} y2={420} frame={frame} delay={72} />
        {/* A60 A40 */}
        <Box x={470} y={420} w={230} h={56} label="A60 · Market Buy" sub="via Uniswap" frame={frame} delay={90} fps={fps} />
        <Box x={720} y={420} w={230} h={56} label="A40 · Platform Buy" sub="from reserve" frame={frame} delay={90} fps={fps} />
        {/* To pool */}
        <Arr x1={585} y1={476} x2={840} y2={562} frame={frame} delay={112} />
        <Arr x1={835} y1={476} x2={900} y2={562} frame={frame} delay={112} />
        <Arr x1={1220} y1={346} x2={1020} y2={562} frame={frame} delay={112} />
        {/* Uniswap pool */}
        <Box x={660} y={562} w={600} h={70} label="Uniswap V2 Liquidity Pool" gold frame={frame} delay={138} fps={fps} />
        {/* To LP lock */}
        <Arr x1={960} y1={632} x2={960} y2={700} frame={frame} delay={160} />
        {/* LP Lock */}
        <Box x={800} y={700} w={320} h={64} label="LP Tokens Locked 🔒" sub="90 days default" frame={frame} delay={175} fps={fps} />
        {/* To streams */}
        {STREAMS.map((st, i) => (
          <Arr key={i} x1={960} y1={764} x2={st.x+175} y2={840} frame={frame} delay={195 + i * 12} />
        ))}
        {/* 4 stream boxes */}
        {STREAMS.map((st, i) => {
          const f2 = Math.max(0, frame - (210 + i * 14));
          const op = interpolate(f2, [0, 16], [0, 1], cl);
          const sc = spring({frame: f2, fps, from: 0.8, to: 1, config: {damping: 200}});
          return (
            <g key={i} transform={`translate(${st.x+175},905) scale(${sc}) translate(${-(st.x+175)},-905)`} opacity={op}>
              <rect x={st.x} y={840} width={350} height={68} rx={4}
                fill={C.panel} stroke={`rgba(201,168,76,0.3)`} strokeWidth={1} />
              <text x={st.x+175} y={870} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={18} letterSpacing={2}>
                {st.label.toUpperCase()}
              </text>
              <text x={st.x+175} y={893} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={13} letterSpacing={1}>
                {st.sub}
              </text>
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
