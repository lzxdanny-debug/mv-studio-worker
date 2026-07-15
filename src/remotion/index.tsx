import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { LyricsOverlay, type LyricsOverlayProps } from './lyrics-overlay';

const defaults: LyricsOverlayProps = { lrcContent: '', durationSec: 1, width: 1280, height: 720, config: {} };
const Root: React.FC = () => <Composition
  id="LyricsOverlay"
  component={LyricsOverlay}
  fps={30}
  width={1280}
  height={720}
  durationInFrames={30}
  defaultProps={defaults}
  calculateMetadata={({ props }) => ({
    durationInFrames: Math.max(1, Math.ceil(props.durationSec * 30)),
    width: props.width,
    height: props.height,
  })}
/>;
registerRoot(Root);
