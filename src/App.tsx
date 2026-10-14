import { Component, useEffect, type ReactNode } from "react";
import { useLayout } from "./state/layout";
import { TitleBar } from "./shell/TitleBar";
import { MenuBar } from "./shell/MenuBar";
import { Toolbar } from "./shell/Toolbar";
import { Sidebar } from "./sidebar/Sidebar";
import { PaneGrid } from "./panes/PaneGrid";
import { RightPanel } from "./panels/RightPanel";

/** Never-break: any render error shows a recoverable message instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <p>Something went wrong{this.props.label ? ` in ${this.props.label}` : ""}: {this.state.error.message}</p>
        <button onClick={() => this.setState({ error: undefined })}>Try again</button>
      </div>
    );
  }
}

export function App() {
  const layout = useLayout();
  return (
    <div className="app">
      <ErrorBoundary label="header">
        <header className="app-header">
          <TitleBar />
          {!layout.menusHidden && <MenuBar />}
        </header>
        <Toolbar />
      </ErrorBoundary>
      <div className="app-body">
        <ErrorBoundary label="sidebar">
          <Sidebar />
        </ErrorBoundary>
        <main className="app-main">
          <ErrorBoundary label="documents">
            <PaneGrid />
          </ErrorBoundary>
        </main>
        <ErrorBoundary label="side panel">
          <RightPanel />
        </ErrorBoundary>
      </div>
    </div>
  );
}
