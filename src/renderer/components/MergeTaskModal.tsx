import React, { useState, useEffect } from 'react';
import { X, GitMerge, Loader2, AlertCircle } from 'lucide-react';
import type { Task, Project, BranchInfo } from '../../shared/types';

interface MergeTaskModalProps {
  task: Task;
  project: Project;
  onClose: () => void;
  onMerged: () => void;
}

export function MergeTaskModal({ task, project, onClose, onMerged }: MergeTaskModalProps) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [targetBranch, setTargetBranch] = useState<string>(project.baseRef || '');
  const [loading, setLoading] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.electronAPI.gitListBranches(project.path);
        if (res.success && res.data) {
          setBranches(res.data);
          // Default to project's baseRef or first branch
          if (!targetBranch && res.data.length > 0) {
            const baseMatch = res.data.find((b) => b.name === project.baseRef);
            setTargetBranch(baseMatch ? baseMatch.name : res.data[0].name);
          }
        }
      } catch {
        // Best effort
      } finally {
        setLoadingBranches(false);
      }
    })();
  }, [project.path]);

  async function handleMerge() {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.gitMergeInto({
        projectPath: project.path,
        sourceBranch: task.branch,
        targetBranch,
      });
      if (res.success) {
        onMerged();
      } else {
        setError(res.error || 'Merge failed');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onClick={loading ? undefined : onClose}
    >
      <div
        className="bg-card border border-border/60 rounded-xl shadow-2xl shadow-black/40 w-[420px] animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 h-12 border-b border-border/60"
          style={{ background: 'hsl(var(--surface-2))' }}
        >
          <h2 className="text-[14px] font-semibold text-foreground">Merge Branch</h2>
          <button
            onClick={onClose}
            disabled={loading}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground/50 hover:text-foreground transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="p-5">
          {/* Source branch (read-only) */}
          <div className="mb-4">
            <label className="block text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">
              Source branch
            </label>
            <div className="px-3 py-2 rounded-lg bg-accent/40 text-[13px] font-mono text-foreground/80">
              {task.branch}
            </div>
          </div>

          {/* Target branch */}
          <div className="mb-4">
            <label className="block text-[11px] font-medium text-muted-foreground/60 uppercase tracking-wider mb-1.5">
              Merge into
            </label>
            {loadingBranches ? (
              <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                Loading branches...
              </div>
            ) : (
              <select
                value={targetBranch}
                onChange={(e) => setTargetBranch(e.target.value)}
                disabled={loading}
                className="w-full px-3 py-2 rounded-lg bg-accent/40 border border-border/60 text-[13px] font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
              >
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Error display */}
          {error && (
            <div className="flex items-start gap-2 p-3 mb-4 rounded-lg bg-destructive/10 border border-destructive/20">
              <AlertCircle
                size={14}
                strokeWidth={2}
                className="text-destructive flex-shrink-0 mt-0.5"
              />
              <p className="text-[12px] text-destructive leading-relaxed">{error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2.5 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 rounded-full text-[13px] text-muted-foreground/60 hover:text-foreground hover:bg-accent/60 transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={loading || !targetBranch || loadingBranches}
              className="flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-medium bg-primary text-primary-foreground hover:brightness-110 transition-all duration-150 disabled:opacity-70 disabled:pointer-events-none"
            >
              {loading ? (
                <>
                  <Loader2 size={13} strokeWidth={2} className="animate-spin" />
                  Merging...
                </>
              ) : (
                <>
                  <GitMerge size={13} strokeWidth={2} />
                  Merge
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
