import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import type { WorktreeInfo, RemoveWorktreeOptions } from '@shared/types';
import { GithubService } from './GithubService';

const execFileAsync = promisify(execFile);

const PRESERVE_PATTERNS = [
  '.env',
  '.env.keys',
  '.env.local',
  '.env.*.local',
  '.envrc',
  'docker-compose.override.yml',
];

/** Directories to link (junction on Windows, symlink on Unix) into new worktrees. */
const PRESERVE_DIRS = ['node_modules'];

export class WorktreeService {
  /**
   * Create a git worktree for a task.
   */
  async createWorktree(
    projectPath: string,
    taskName: string,
    options: {
      baseRef?: string;
      existingBranch?: string;
      projectId: string;
      linkedIssueNumbers?: number[];
      pushRemote?: boolean;
      linkedProjectPath?: string;
      linkedProjectId?: string;
      linkedExistingBranch?: string;
      linkedBaseRef?: string;
      linkedPushRemote?: boolean;
    },
  ): Promise<WorktreeInfo> {
    // Multi-repo: delegate to specialized method
    if (options.linkedProjectPath) {
      return this.createMultiRepoWorktree(projectPath, taskName, options);
    }

    const slug = this.slugify(taskName);
    const hash = this.generateShortHash();

    const worktreesDir = this.getWorktreesDir(projectPath);
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    let branchName: string;
    const worktreePath = path.join(worktreesDir, `${slug}-${hash}`);

    if (options.existingBranch) {
      // Use existing branch — no -b flag, --force allows branch already checked out elsewhere
      branchName = options.existingBranch;
      await execFileAsync('git', ['worktree', 'add', '--force', worktreePath, branchName], {
        cwd: projectPath,
      });
    } else {
      // Create new branch
      branchName = `${slug}-${hash}`;
      const baseRef = await this.resolveBaseRef(projectPath, options.baseRef);
      await execFileAsync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
        cwd: projectPath,
      });
    }

    // Copy preserved files
    await this.preserveFiles(projectPath, worktreePath);

    // Push to remote if requested (default: true for backwards compat, skip for existing branch)
    if (!options.existingBranch) {
      const pushRemote = options.pushRemote ?? true;
      if (pushRemote) {
        if (options.linkedIssueNumbers && options.linkedIssueNumbers.length > 0) {
          this.linkAndPushAsync(worktreePath, branchName, options.linkedIssueNumbers);
        } else {
          this.pushBranchAsync(worktreePath, branchName);
        }
      }
    }

    const id = this.stableIdFromPath(worktreePath);
    return {
      id,
      name: taskName,
      branch: branchName,
      path: worktreePath,
      projectId: options.projectId,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Create a multi-repo worktree with primary and linked repos as subdirectories.
   */
  private async createMultiRepoWorktree(
    projectPath: string,
    taskName: string,
    options: {
      baseRef?: string;
      existingBranch?: string;
      projectId: string;
      linkedIssueNumbers?: number[];
      pushRemote?: boolean;
      linkedProjectPath?: string;
      linkedProjectId?: string;
      linkedExistingBranch?: string;
      linkedBaseRef?: string;
      linkedPushRemote?: boolean;
    },
  ): Promise<WorktreeInfo> {
    const slug = this.slugify(taskName);
    const hash = this.generateShortHash();
    const worktreesDir = this.getWorktreesDir(projectPath);

    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    // Parent dir containing both repos
    const parentDir = path.join(worktreesDir, `${slug}-${hash}`);
    fs.mkdirSync(parentDir, { recursive: true });

    const primaryPath = path.join(parentDir, 'backend');
    const linkedPath = path.join(parentDir, 'frontend');
    const linkedProjectPath = options.linkedProjectPath!;

    // Create primary worktree
    let primaryBranch: string;
    if (options.existingBranch) {
      primaryBranch = options.existingBranch;
      await execFileAsync('git', ['worktree', 'add', '--force', primaryPath, primaryBranch], {
        cwd: projectPath,
      });
    } else {
      primaryBranch = `${slug}-${hash}`;
      const baseRef = await this.resolveBaseRef(projectPath, options.baseRef);
      await execFileAsync('git', ['worktree', 'add', '-b', primaryBranch, primaryPath, baseRef], {
        cwd: projectPath,
      });
    }

    // Create linked worktree
    let linkedBranch: string;
    let linkedBranchCreatedByDash: boolean;
    if (options.linkedExistingBranch) {
      linkedBranch = options.linkedExistingBranch;
      linkedBranchCreatedByDash = false;
      await execFileAsync('git', ['worktree', 'add', '--force', linkedPath, linkedBranch], {
        cwd: linkedProjectPath,
      });
    } else {
      linkedBranch = `${slug}-${hash}`;
      linkedBranchCreatedByDash = true;
      const linkedBaseRef = await this.resolveBaseRef(linkedProjectPath, options.linkedBaseRef);
      await execFileAsync(
        'git',
        ['worktree', 'add', '-b', linkedBranch, linkedPath, linkedBaseRef],
        { cwd: linkedProjectPath },
      );
    }

    // Preserve files for both repos
    await this.preserveFiles(projectPath, primaryPath);
    await this.preserveFiles(linkedProjectPath, linkedPath);

    // Push branches if new
    if (!options.existingBranch) {
      const pushRemote = options.pushRemote ?? true;
      if (pushRemote) {
        if (options.linkedIssueNumbers && options.linkedIssueNumbers.length > 0) {
          this.linkAndPushAsync(primaryPath, primaryBranch, options.linkedIssueNumbers);
        } else {
          this.pushBranchAsync(primaryPath, primaryBranch);
        }
      }
    }
    if (!options.linkedExistingBranch) {
      const linkedPush = options.linkedPushRemote ?? true;
      if (linkedPush) {
        this.pushBranchAsync(linkedPath, linkedBranch);
      }
    }

    const id = this.stableIdFromPath(parentDir);
    return {
      id,
      name: taskName,
      branch: primaryBranch,
      path: parentDir,
      projectId: options.projectId,
      status: 'active',
      createdAt: new Date().toISOString(),
      linkedBranch,
      linkedBranchCreatedByDash,
    };
  }

  /**
   * Remove a worktree and clean up branches.
   */
  async removeWorktree(
    projectPath: string,
    worktreePath: string,
    branch: string,
    options?: RemoveWorktreeOptions,
  ): Promise<void> {
    const deleteWorktreeDir = options?.deleteWorktreeDir ?? true;
    const deleteLocalBranch = options?.deleteLocalBranch ?? true;
    const deleteRemoteBranch = options?.deleteRemoteBranch ?? true;

    const isMultiRepo = !!(options?.linkedProjectPath && options?.linkedBranch);

    // Safety: never remove the project directory itself
    const normalizedProject = path.resolve(projectPath);
    const normalizedWorktree = path.resolve(worktreePath);
    if (normalizedWorktree === normalizedProject) {
      throw new Error('Cannot remove project directory as worktree');
    }

    // For multi-repo tasks, remove linked worktree first
    if (isMultiRepo && deleteWorktreeDir) {
      const linkedProjectPath = options!.linkedProjectPath!;
      const linkedBranch = options!.linkedBranch!;
      const linkedWorktreePath = path.join(worktreePath, 'frontend');

      // Remove linked worktree
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', linkedWorktreePath], {
          cwd: linkedProjectPath,
        });
      } catch {
        if (fs.existsSync(linkedWorktreePath)) {
          fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
        }
      }
      try {
        await execFileAsync('git', ['worktree', 'prune'], { cwd: linkedProjectPath });
      } catch {
        /* best effort */
      }

      // Delete linked branches
      if (options?.deleteLinkedLocalBranch) {
        try {
          await execFileAsync('git', ['branch', '-D', linkedBranch], { cwd: linkedProjectPath });
        } catch {
          /* may not exist */
        }
      }
      if (options?.deleteLinkedRemoteBranch) {
        execFileAsync('git', ['push', 'origin', '--delete', linkedBranch], {
          cwd: linkedProjectPath,
        }).catch(() => {});
      }
    }

    if (deleteWorktreeDir) {
      // For multi-repo: primary worktree is at worktreePath/backend
      const actualWorktreePath = isMultiRepo ? path.join(worktreePath, 'backend') : worktreePath;
      const normalizedActual = path.resolve(actualWorktreePath);

      // Verify this is actually a worktree
      try {
        const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: projectPath,
        });
        if (!stdout.includes(normalizedActual)) {
          if (fs.existsSync(normalizedActual)) {
            fs.rmSync(normalizedActual, { recursive: true, force: true });
          }
          // For multi-repo, also clean up parent dir
          if (isMultiRepo && fs.existsSync(normalizedWorktree)) {
            fs.rmSync(normalizedWorktree, { recursive: true, force: true });
          }
          return;
        }
      } catch {
        // If list fails, continue with removal anyway
      }

      // Remove primary worktree
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', actualWorktreePath], {
          cwd: projectPath,
        });
      } catch {
        if (fs.existsSync(actualWorktreePath)) {
          fs.rmSync(actualWorktreePath, { recursive: true, force: true });
        }
      }

      // Prune
      try {
        await execFileAsync('git', ['worktree', 'prune'], { cwd: projectPath });
      } catch {
        // Best effort
      }

      // For multi-repo, remove the parent directory
      if (isMultiRepo && fs.existsSync(normalizedWorktree)) {
        fs.rmSync(normalizedWorktree, { recursive: true, force: true });
      }
    }

    // Delete local branch
    if (deleteLocalBranch) {
      try {
        await execFileAsync('git', ['branch', '-D', branch], { cwd: projectPath });
      } catch {
        // May not exist
      }
    }

    // Delete remote branch (best effort, non-blocking)
    if (deleteRemoteBranch) {
      execFileAsync('git', ['push', 'origin', '--delete', branch], { cwd: projectPath }).catch(
        () => {},
      );
    }
  }

  /**
   * Resolve the base ref for worktree creation.
   */
  async resolveBaseRef(projectPath: string, override?: string): Promise<string> {
    if (override) return override;

    // Try to get remote HEAD
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'show', 'origin'], {
        cwd: projectPath,
        timeout: 5000,
      });
      const match = stdout.match(/HEAD branch:\s*(\S+)/);
      if (match) return match[1];
    } catch {
      // Ignore
    }

    // Try current branch
    try {
      const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: projectPath,
      });
      const branch = stdout.trim();
      if (branch) return branch;
    } catch {
      // Ignore
    }

    return 'main';
  }

  /**
   * Copy preserved files (.env, etc) from source to target.
   */
  async preserveFiles(from: string, to: string): Promise<void> {
    for (const pattern of PRESERVE_PATTERNS) {
      // Simple glob: if no wildcard, just check exact file
      if (!pattern.includes('*')) {
        const srcFile = path.join(from, pattern);
        const destFile = path.join(to, pattern);
        if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
          try {
            fs.copyFileSync(srcFile, destFile, fs.constants.COPYFILE_EXCL);
          } catch {
            // Skip if exists
          }
        }
      } else {
        // For wildcard patterns, list files and match
        try {
          const files = fs.readdirSync(from);
          const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
          for (const file of files) {
            if (regex.test(file)) {
              const srcFile = path.join(from, file);
              const destFile = path.join(to, file);
              if (!fs.existsSync(destFile)) {
                try {
                  fs.copyFileSync(srcFile, destFile, fs.constants.COPYFILE_EXCL);
                } catch {
                  // Skip
                }
              }
            }
          }
        } catch {
          // Skip
        }
      }
    }

    // Link directories (junction on Windows, symlink on Unix) — avoids reinstalling
    for (const dir of PRESERVE_DIRS) {
      const srcDir = path.join(from, dir);
      const destDir = path.join(to, dir);
      try {
        if (fs.existsSync(srcDir) && !fs.existsSync(destDir)) {
          const srcReal = fs.realpathSync(srcDir);
          fs.symlinkSync(srcReal, destDir, process.platform === 'win32' ? 'junction' : 'dir');
        }
      } catch {
        // Skip — may fail if source is missing or permissions issue
      }
    }
  }

  private async linkAndPushAsync(
    cwd: string,
    branch: string,
    issueNumbers: number[],
  ): Promise<void> {
    try {
      // createLinkedBranch creates the branch on the remote AND links it to the issue.
      // Must happen before push so the branch doesn't already exist on the remote.
      for (const num of issueNumbers) {
        try {
          const issueUrl = await GithubService.linkBranch(cwd, num, branch);
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
              win.webContents.send('app:toast', {
                message: `Issue #${num} linked to branch '${branch}'`,
                url: issueUrl,
              });
            }
          }
        } catch {
          // Best effort — gh may not be available
        }
      }
      // Set upstream tracking (branch already exists on remote from createLinkedBranch)
      await execFileAsync('git', ['branch', '--set-upstream-to', `origin/${branch}`, branch], {
        cwd,
      });
    } catch {
      // Fallback: just push normally if linking failed
      this.pushBranchAsync(cwd, branch);
    }
  }

  private pushBranchAsync(cwd: string, branch: string): void {
    execFileAsync('git', ['push', '-u', 'origin', branch], { cwd }).catch(() => {
      // Best effort — no remote is fine
    });
  }

  getWorktreesDir(projectPath: string): string {
    return path.join(path.dirname(projectPath), 'worktrees');
  }

  slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }

  generateShortHash(): string {
    return crypto.randomBytes(3).toString('hex').slice(0, 3);
  }

  stableIdFromPath(worktreePath: string): string {
    const hash = crypto.createHash('sha1').update(worktreePath).digest('hex').slice(0, 12);
    return `wt-${hash}`;
  }
}

export const worktreeService = new WorktreeService();
