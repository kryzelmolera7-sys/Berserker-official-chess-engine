import React, { useState, useEffect } from 'react';
import { 
  Terminal, 
  Code2, 
  Layers, 
  Play, 
  Gem, 
  Cloud, 
  LogIn, 
  LogOut,
  Award,
  Download
} from 'lucide-react';
import { UciEngineConsole } from './UciEngineConsole';
import { EngineCliGuide } from './EngineCliGuide';
import { BerserkerNnueInspector } from './BerserkerNnueInspector';
import { PlayVsEngine } from './PlayVsEngine';
import { BerserkerReleaseDownloads } from './BerserkerReleaseDownloads';
import { CloudGamesModal } from './CloudGamesModal';
import { loginWithGoogle, logoutUser, subscribeAuth } from './firebaseService';
import type { User } from 'firebase/auth';

export default function App() {
  const [activeTab, setActiveTab] = useState<'terminal' | 'guide' | 'neural' | 'board' | 'downloads'>('board');
  const [showCloudGamesModal, setShowCloudGamesModal] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState<boolean>(false);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [activeTab]);

  useEffect(() => {
    const unsub = subscribeAuth((user) => {
      setCurrentUser(user);
    });
    return () => unsub();
  }, []);

  const handleGoogleSignIn = async () => {
    setIsAuthLoading(true);
    try {
      await loginWithGoogle();
    } catch (e) {
      console.warn('Google sign-in action notice:', e);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await logoutUser();
    } catch (e) {
      console.warn('Sign out action notice:', e);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-purple-500 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur px-4 lg:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-600 via-indigo-600 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-purple-600/30">
            <Gem className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-black tracking-tight text-white flex items-center gap-1.5">
                <span>Berserker</span>
              </h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40 font-bold uppercase">
                v0.7.0 Dev
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-bold hidden sm:inline-block">
                Quad-Head NNUE & MCTS-DAG
              </span>
            </div>
            <p className="text-[11px] text-slate-400">
              Neural MCTS-DAG & Threat-Space Prophylaxis II • BRnnue Quad-Head Architecture • Bayesian Arbiter
            </p>
          </div>
        </div>

        {/* Tab Navigation: Pure Engine Terminal, CLI Guide, NNUE, Board, Downloads */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
          <button
            onClick={() => setActiveTab('downloads')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'downloads'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-extrabold'
                : 'text-amber-400 hover:text-amber-300'
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            <span>v0.7.0 Downloads</span>
          </button>

          <button
            onClick={() => setActiveTab('terminal')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'terminal'
                ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>UCI Engine Shell</span>
          </button>

          <button
            onClick={() => setActiveTab('guide')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'guide'
                ? 'bg-emerald-600 text-white shadow-md'
                : 'text-emerald-400 hover:text-emerald-300'
            }`}
          >
            <Code2 className="w-3.5 h-3.5" />
            <span>CLI & Benchmark</span>
          </button>

          <button
            onClick={() => setActiveTab('neural')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'neural'
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md shadow-purple-600/20'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5 text-pink-400" />
            <span>BRnnue Architecture</span>
          </button>

          <button
            onClick={() => setActiveTab('board')}
            className={`px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
              activeTab === 'board'
                ? 'bg-slate-800 text-white shadow-md'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Play className="w-3.5 h-3.5 text-slate-300" />
            <span>Board Visualizer</span>
          </button>
        </div>

        {/* Cloud Archive & Auth Widget */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCloudGamesModal(true)}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition border border-slate-700 shadow-sm"
            title="Browse Community Cloud Games"
          >
            <Cloud className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Cloud Archive</span>
          </button>

          {currentUser ? (
            <div className="flex items-center gap-2 bg-slate-800/80 px-2.5 py-1 rounded-xl border border-slate-700/60">
              <span className="text-[11px] font-mono font-medium text-slate-300 truncate max-w-[100px] hidden sm:inline">
                {currentUser.displayName || currentUser.email?.split('@')[0]}
              </span>
              <button
                onClick={handleSignOut}
                className="p-1 rounded-lg text-slate-400 hover:text-rose-400 transition"
                title="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={handleGoogleSignIn}
              disabled={isAuthLoading}
              className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition border border-slate-700 shadow-sm"
            >
              <LogIn className="w-3.5 h-3.5 text-emerald-400" />
              <span>Sign in</span>
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-4 lg:p-8 max-w-7xl mx-auto w-full">
        {/* Tab 0: Release Downloads Hub */}
        {activeTab === 'downloads' && (
          <BerserkerReleaseDownloads />
        )}

        {/* Tab 1: Direct UCI Engine Shell */}
        {activeTab === 'terminal' && (
          <UciEngineConsole />
        )}

        {/* Tab 2: Standalone Engine CLI & +570 Elo Benchmark Guide */}
        {activeTab === 'guide' && (
          <EngineCliGuide />
        )}

        {/* Tab 3: BRnnue & Architecture Inspector */}
        {activeTab === 'neural' && (
          <BerserkerNnueInspector />
        )}

        {/* Tab 4: Engine Board Visualizer */}
        {activeTab === 'board' && (
          <PlayVsEngine maxThreads={64} hashSizeMb={32768} />
        )}
      </main>

      {/* Cloud Games Archive Modal */}
      <CloudGamesModal
        isOpen={showCloudGamesModal}
        onClose={() => setShowCloudGamesModal(false)}
      />

      {/* Clean Footer */}
      <footer className="border-t border-slate-900 bg-slate-950/80 px-4 lg:px-8 py-3 text-center text-xs text-slate-500">
        Berserker v0.7.0-dev Official Release • Neural MCTS-DAG & Threat-Space Prophylaxis II • BRnnue Quad-Head NNUE • 64 Threads • 32GB Hash
      </footer>
    </div>
  );
}
