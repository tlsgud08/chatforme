import { Component, type ReactNode } from 'react';

export default class PageLoadBoundary extends Component<{ children: ReactNode; resetKey: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous: Readonly<{ children: ReactNode; resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center" role="alert">
        <p className="text-sm text-slate-400">화면을 불러오지 못했습니다. 연결을 확인하고 다시 열어 주세요.</p>
        <button type="button" onClick={() => window.location.reload()} className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white">다시 불러오기</button>
      </div>
    );
    return this.props.children;
  }
}
