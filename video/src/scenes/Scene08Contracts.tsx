import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const CONTRACTS = [
  {name:'Liquidity.sol',       role:'MAIN CONTRACT',          desc:'User registry · LP custody · Entry point',             delay:60},
  {name:'LiquidityFacet.sol',  role:'EXECUTION FACET',        desc:'Invest logic · Commissions · TWAP guards',             delay:130},
  {name:'LiquidityROIFacet.sol',role:'ROI STREAM MANAGER',    desc:'Per-lock stream tracking · Settlement · Accrual',      delay:200},
  {name:'LiquidityMath.sol',   role:'PURE MATH LIBRARY',      desc:'Reward calc · AMM math · Slippage protection',         delay:268},
];

const SECURITY = [
  '✓  Reentrancy guard on all state-changing functions',
  '✓  2% max slippage on all swaps',
  '✓  5% TWAP deviation guard · 30-second window',
  '✓  Admin key cannot touch locked LP tokens',
  '✓  Non-custodial · 100% on-chain · Verifiable',
];

export const Scene08Contracts: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [990, 1050], [1, 0], cl);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity:interpolate(frame,[0,18],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:66,letterSpacing:5,color:C.gold,margin:0}}>SMART CONTRACT ARCHITECTURE</p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          Modular · Transparent · Non-Custodial · 100% On-Chain
        </p>
      </div>

      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {/* Contract stack */}
        {CONTRACTS.map(({name, role, desc, delay}, i) => {
          const cf = Math.max(0, frame - delay);
          const op = interpolate(cf, [0, 18], [0, 1], cl);
          const tx = spring({frame: cf, fps, from: -70, to: 0, config: {damping: 200}});
          const Y = 178 + i * 152;
          const isTop = i === 0;
          return (
            <g key={i} opacity={op} transform={`translate(${tx},0)`}>
              {/* Connector line to next */}
              {i < CONTRACTS.length - 1 && (
                <line x1={185} y1={Y + 118} x2={185} y2={Y + 152}
                  stroke={C.gold} strokeWidth={1.2} strokeDasharray="3 6" opacity={0.3} />
              )}
              <rect x={78} y={Y} width={1060} height={132} rx={4}
                fill={isTop ? 'rgba(201,168,76,0.06)' : C.panel}
                stroke={isTop ? `rgba(201,168,76,0.25)` : C.border}
                strokeWidth={isTop ? 1.2 : 1} />
              {/* Number badge */}
              <rect x={88} y={Y + 10} width={190} height={112} rx={4}
                fill={isTop ? 'rgba(201,168,76,0.12)' : C.surface}
                stroke={isTop ? `rgba(201,168,76,0.2)` : C.border} strokeWidth={1} />
              <text x={183} y={Y + 48} textAnchor="middle"
                fill={isTop ? C.gold : C.muted}
                fontFamily={MONO} fontSize={11} letterSpacing={3}>{`0${i+1}`}</text>
              <text x={183} y={Y + 78} textAnchor="middle"
                fill={isTop ? C.gold : C.muted}
                fontFamily={MONO} fontSize={10} letterSpacing={2}>
                {['MAIN', 'FACET', 'ROI', 'MATH'][i]}
              </text>
              {/* Name and desc */}
              <text x={300} y={Y + 42}
                fill={isTop ? C.gold2 : C.cream}
                fontFamily={DISPLAY} fontSize={24} letterSpacing={3}>{name}</text>
              <text x={300} y={Y + 70}
                fill={isTop ? C.gold : C.muted}
                fontFamily={MONO} fontSize={11} letterSpacing={2.5}>{role}</text>
              <text x={300} y={Y + 96}
                fill={C.muted} fontFamily={MONO} fontSize={13} letterSpacing={0.5}>{desc}</text>
            </g>
          );
        })}

        {/* DELEGATECALL badge */}
        {(() => {
          const df = Math.max(0, frame - 148);
          const op = interpolate(df, [0, 18], [0, 1], cl);
          return (
            <g opacity={op}>
              <rect x={1188} y={246} width={195} height={220} rx={4}
                fill={C.panel} stroke={`rgba(201,168,76,0.2)`} strokeWidth={1} />
              <text x={1286} y={310} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={19} letterSpacing={2}>DELEGATE</text>
              <text x={1286} y={334} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={19} letterSpacing={2}>CALL</text>
              <text x={1286} y={358} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={1}>No fund movement</text>
              <text x={1286} y={380} textAnchor="middle"
                fill={C.muted} fontFamily={MONO} fontSize={11} letterSpacing={1}>Storage shared</text>
              <line x1={1138} y1={262} x2={1188} y2={302} stroke={C.gold} strokeWidth={1} opacity={0.3} />
              <line x1={1138} y1={398} x2={1188} y2={398} stroke={C.gold} strokeWidth={1} opacity={0.3} />
            </g>
          );
        })()}

        {/* Security checklist */}
        {(() => {
          const sf = Math.max(0, frame - 390);
          const op = interpolate(sf, [0, 18], [0, 1], cl);
          const ty = spring({frame: sf, fps, from: 30, to: 0, config: {damping: 200}});
          return (
            <g opacity={op} transform={`translate(0,${ty})`}>
              <rect x={1240} y={480} width={630} height={476} rx={4}
                fill={C.panel} stroke={C.border} strokeWidth={1} />
              <text x={1555} y={530} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={22} letterSpacing={4}>SECURITY</text>
              <line x1={1258} y1={546} x2={1852} y2={546} stroke={C.border} strokeWidth={1} />
              {SECURITY.map((line, i) => {
                const lf = Math.max(0, frame - (430 + i * 26));
                return (
                  <text key={i} x={1268} y={592 + i * 66}
                    fill={i === 0 ? C.gold2 : C.text}
                    fontFamily={MONO} fontSize={17}
                    opacity={interpolate(lf,[0,16],[0,1],cl)}>
                    {line}
                  </text>
                );
              })}
            </g>
          );
        })()}
      </svg>
    </AbsoluteFill>
  );
};
