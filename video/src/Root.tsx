import React from 'react';
import {Composition, registerRoot} from 'remotion';
import {HordexVideo} from './HordexVideo';
import './fonts';

// 3s splash + 358s content = 361s total at 30fps = 10830 frames
const RemotionRoot: React.FC = () => (
  <Composition
    id="HordexVideo"
    component={HordexVideo}
    durationInFrames={10830}
    fps={30}
    width={1920}
    height={1080}
  />
);

registerRoot(RemotionRoot);
