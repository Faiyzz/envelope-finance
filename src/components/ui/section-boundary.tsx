'use client';

/** Per-section error boundary: a failing section must not blank the page (TD-10 §4.5). */

import { Component, type ReactNode } from 'react';
import { ErrorState } from './states';
import { msg } from '@/messages/en';

interface Props {
  section: string;
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class SectionBoundary extends Component<Props, State> {
  state: State = { failed: false };
  static getDerivedStateFromError(): State {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <ErrorState
          title={msg.dash.sectionFailed({ section: this.props.section })}
          onRetry={() => this.setState({ failed: false })}
        />
      );
    }
    return this.props.children;
  }
}
