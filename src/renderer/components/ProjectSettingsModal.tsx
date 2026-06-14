import React, { useState } from 'react';
import { X, Trash2, AlertTriangle } from 'lucide-react';
import { AdoConnectionForm } from './AdoConnectionForm';
import { isAdoRemote } from '../../shared/urls';
import type { Project } from '../../shared/types';

interface ProjectSettingsModalProps {
  project: Project;
  onClose: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectSettingsModal({
  project,
  onClose,
  onRename,
  onDelete,
}: ProjectSettingsModalProps) {
  const [name, setName] = useState(project.name);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function handleSaveName() {
    const trimmed = name.trim();
    if (trimmed && trimmed !== project.name) {
      onRename(project.id, trimmed);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border/60 rounded-xl shadow-2xl shadow-black/40 w-[460px] max-h-[80vh] flex flex-col animate-slide-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 h-12 border-b border-border/60 flex-shrink-0"
          style={{ background: 'hsl(var(--surface-2))' }}
        >
          <h2 className="text-[14px] font-semibold text-foreground">Project Settings</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent text-foreground/50 hover:text-foreground transition-all duration-150"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto flex-1">
          {/* Project name */}
          <div>
            <label className="block text-[12px] font-medium text-muted-foreground/70 mb-2">
              Project name
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                }}
                className="flex-1 px-3.5 py-2.5 rounded-lg bg-background border border-input/60 text-foreground text-[13px] placeholder:text-muted-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/30 focus:border-ring/50 transition-all duration-150"
              />
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-1.5 font-mono truncate">
              {project.path}
            </p>
          </div>

          {/* Azure DevOps connection — only for ADO projects */}
          {isAdoRemote(project.gitRemote) && (
            <div>
              <label className="block text-[12px] font-medium text-muted-foreground/70 mb-2">
                Azure DevOps
              </label>
              <AdoConnectionForm projectId={project.id} />
            </div>
          )}

          {/* Danger zone */}
          <div className="pt-1 border-t border-border/40">
            <label className="block text-[12px] font-medium text-destructive/80 mb-2 mt-4">
              Danger zone
            </label>

            {confirmingDelete ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3.5">
                <div className="flex gap-2.5">
                  <AlertTriangle
                    size={15}
                    strokeWidth={1.8}
                    className="text-destructive flex-shrink-0 mt-0.5"
                  />
                  <p className="text-[12px] text-foreground/80 leading-relaxed">
                    This permanently removes{' '}
                    <span className="font-medium text-foreground">{project.name}</span> and all its
                    tasks from Dash. Worktrees and branches on disk are not affected.
                  </p>
                </div>
                <div className="flex justify-end gap-2 mt-3.5">
                  <button
                    onClick={() => setConfirmingDelete(false)}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-medium border border-border/60 text-foreground/70 hover:bg-accent/40 hover:text-foreground transition-all duration-150"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => onDelete(project.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-all duration-150"
                  >
                    <Trash2 size={12} strokeWidth={1.8} />
                    Delete project
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium border border-destructive/40 text-destructive hover:bg-destructive/10 transition-all duration-150"
              >
                <Trash2 size={13} strokeWidth={1.8} />
                Delete project
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
