import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {C, DISPLAY, MONO} from '../theme';

const cl = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const ROWS = [
  {invest: '$100',     d7: '1.0%',  d30: '6.0%',  d90: '25.0%', d360: '168%'},
  {invest: '$1,000',   d7: '1.1%',  d30: '6.2%',  d90: '26.0%', d360: '172%'},
  {invest: '$5,000',   d7: '1.2%',  d30: '6.4%',  d90: '27.0%', d360: '174%'},
  {invest: '$25,000',  d7: '1.3%',  d30: '6.5%',  d90: '28.0%', d360: '178%'},
  {invest: '$100,000', d7: '1.4%',  d30: '6.7%',  d90: '29.0%', d360: '181%'},
  {invest: '$500,000', d7: '1.5%',  d30: '6.75%', d90: '30.0%', d360: '184%'},
];
const HEADERS = ['INVESTMENT', '7 DAYS', '30 DAYS', '90 DAYS', '360 DAYS'];
const CX = [100, 370, 560, 750, 940];
const CW = [260, 180, 180, 180, 210];

export const Scene04Tiers: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const fadeOut = interpolate(frame, [1320, 1380], [1, 0], cl);
  const fadeIn  = interpolate(frame, [0, 18], [0, 1], cl);

  const VALS = ROWS.map(r => [r.invest, r.d7, r.d30, r.d90, r.d360]);

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, opacity: fadeIn * fadeOut}}>
      <div style={{position:'absolute',top:44,left:'50%',transform:'translateX(-50%)',textAlign:'center',
        opacity: interpolate(frame,[0,20],[0,1],cl)}}>
        <p style={{fontFamily:DISPLAY,fontSize:64,letterSpacing:5,color:C.gold,margin:0}}>
          INVESTMENT PACKAGES & LOCK DURATIONS
        </p>
        <p style={{fontFamily:MONO,fontSize:12,letterSpacing:4,color:C.muted,margin:'8px 0 0',textTransform:'uppercase'}}>
          14 Tiers · $25 → $500,000 · Rate Fixed at Entry · Never Changes Mid-Lock
        </p>
      </div>

      <svg style={{position:'absolute',inset:0,width:'100%',height:'100%'}} viewBox="0 0 1920 1080">
        {/* Column headers */}
        {HEADERS.map((h, ci) => {
          const hf = Math.max(0, frame - 30 - ci * 10);
          const op = interpolate(hf, [0, 16], [0, 1], cl);
          return (
            <text key={ci} x={CX[ci] + CW[ci]/2} y={218} textAnchor="middle"
              fill={ci === 4 ? C.gold : C.muted}
              fontFamily={MONO} fontSize={ci === 4 ? 15 : 12}
              letterSpacing={2.5} opacity={op}>
              {h}
            </text>
          );
        })}

        {/* Header divider */}
        <line x1={90} y1={234}
          x2={90 + 1080 * interpolate(Math.max(0, frame - 70), [0, 28], [0, 1], cl)}
          y2={234} stroke={C.border} strokeWidth={1} />

        {/* Data rows */}
        {ROWS.map((_, ri) => {
          const rowDelay = 92 + ri * 38;
          const rf = Math.max(0, frame - rowDelay);
          const op = interpolate(rf, [0, 18], [0, 1], cl);
          const y = 248 + ri * 100;
          const isLast = ri === ROWS.length - 1;
          const vals = VALS[ri];
          return (
            <g key={ri} opacity={op}>
              {isLast && (
                <rect x={86} y={y-8} width={1088} height={86} rx={4}
                  fill={C.gold} opacity={0.06} />
              )}
              {vals.map((val, ci) => (
                <text key={ci} x={CX[ci] + CW[ci]/2} y={y + 38}
                  textAnchor="middle"
                  fill={ci === 4 ? C.gold2 : ci > 0 ? C.cream : C.text}
                  fontFamily={ci === 0 ? MONO : DISPLAY}
                  fontSize={ci === 4 ? 32 : ci > 0 ? 28 : 22}
                  letterSpacing={ci === 0 ? 0.5 : 2}
                  fontWeight={ci === 4 ? 'bold' : 'normal'}>
                  {val}
                </text>
              ))}
              {ri < ROWS.length - 1 && (
                <line x1={90} y1={y + 72} x2={1178} y2={y + 72}
                  stroke={C.border} strokeWidth={0.8} opacity={0.6} />
              )}
            </g>
          );
        })}

        {/* Right callout box */}
        {(() => {
          const cf = Math.max(0, frame - 680);
          const op = interpolate(cf, [0, 20], [0, 1], cl);
          const sc = spring({frame: cf, fps, from: 0.88, to: 1, config: {damping: 200}});
          return (
            <g opacity={op} transform={`translate(1290,285) scale(${sc}) translate(-1290,-285)`}>
              <rect x={1250} y={200} width={610} height={600} rx={4}
                fill={C.panel} stroke={`rgba(201,168,76,0.2)`} strokeWidth={1} />
              <text x={1555} y={255} textAnchor="middle"
                fill={C.gold} fontFamily={DISPLAY} fontSize={24} letterSpacing={4}>
                MAX RETURN EXAMPLE
              </text>
              <line x1={1268} y1={272} x2={1842} y2={272} stroke={C.border} strokeWidth={1} />
              {[
                ['Investment',      '$500,000'],
                ['Lock Duration',   '360 Days'],
                ['Base Rate',       '184%'],
                ['+ Streak 3',      '+30%'],
                ['Total Rate',      '214%'],
                ['Payout',          '$1,070,000'],
              ].map(([k, v], i) => (
                <g key={i}>
                  <text x={1278} y={318 + i * 68}
                    fill={C.muted} fontFamily={MONO} fontSize={13} letterSpacing={1}>{k}</text>
                  <text x={1842} y={318 + i * 68} textAnchor="end"
                    fill={i >= 4 ? C.gold : C.cream}
                    fontFamily={i >= 4 ? DISPLAY : MONO}
                    fontSize={i >= 4 ? 32 : 22}
                    letterSpacing={i >= 4 ? 3 : 0.5}>
                    {v}
                  </text>
                </g>
              ))}
            </g>
          );
        })()}
      </svg>
    </AbsoluteFill>
  );
};
