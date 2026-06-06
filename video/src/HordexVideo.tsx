import React from 'react';
import {AbsoluteFill, Sequence, Audio, staticFile} from 'remotion';
import {C, GRID_BG} from './theme';
import {Scene00Splash} from './scenes/Scene00Splash';
import {Scene01Hook} from './scenes/Scene01Hook';
import {Scene02Intro} from './scenes/Scene02Intro';
import {Scene03HowItWorks} from './scenes/Scene03HowItWorks';
import {Scene04Tiers} from './scenes/Scene04Tiers';
import {Scene05Streak} from './scenes/Scene05Streak';
import {Scene06Referral} from './scenes/Scene06Referral';
import {Scene07ROI} from './scenes/Scene07ROI';
import {Scene08Contracts} from './scenes/Scene08Contracts';
import {Scene09EarlyMover} from './scenes/Scene09EarlyMover';
import {Scene10CTA} from './scenes/Scene10CTA';

const f = (sec: number) => Math.round(sec * 30);

// All original script timings shifted +3s for splash intro
// [start_sec, duration_sec, Component]
const SCENES: [number, number, React.FC][] = [
  [0,   3,  Scene00Splash],
  [3,   13, Scene01Hook],
  [16,  26, Scene02Intro],
  [42,  40, Scene03HowItWorks],
  [82,  46, Scene04Tiers],
  [128, 41, Scene05Streak],
  [169, 53, Scene06Referral],
  [222, 52, Scene07ROI],
  [274, 35, Scene08Contracts],
  [309, 40, Scene09EarlyMover],
  [349, 12, Scene10CTA],
];

export const HordexVideo: React.FC = () => (
  <AbsoluteFill style={{backgroundColor: C.bg}}>
    {/* Persistent grid overlay — exact match to app's body::before */}
    <div style={{
      position: 'absolute', inset: 0, zIndex: 1000, pointerEvents: 'none',
      ...GRID_BG,
    }} />

    {/* Top radial gold glow orb — matches body::after in base.css */}
    <div style={{
      position: 'absolute', top: -200, left: '50%', transform: 'translateX(-50%)',
      width: 700, height: 500, zIndex: 999, pointerEvents: 'none',
      background: 'radial-gradient(ellipse, rgba(201,168,76,0.08) 0%, transparent 65%)',
    }} />

    {/* Bottom-right glow orb — matches .orb2 in base.css */}
    <div style={{
      position: 'absolute', bottom: -200, right: -200,
      width: 700, height: 700, zIndex: 999, pointerEvents: 'none',
      background: 'radial-gradient(circle, rgba(201,168,76,0.04) 0%, transparent 70%)',
    }} />

    <Audio src={staticFile('voiceover.mp3')} startFrom={f(3)} />

    {SCENES.map(([start, dur, SceneComp], i) => (
      <Sequence key={i} from={f(start)} durationInFrames={f(dur)}>
        <SceneComp />
      </Sequence>
    ))}
  </AbsoluteFill>
);
