/**
 * Git Integration Utilities
 *
 * Shared functions for checking child job integration status via git.
 * Used by JobContextProvider (prompt building) and autoDispatch (verification gating).
 */

import { execSync } from 'node:child_process';
import { workerLogger } from '../../logging/index.js';

/**
 * Check if a child's work is already integrated into the parent branch.
 * Returns true if:
 * - Branch doesn't exist on remote (deleted = merged or rejected)
 * - Branch's HEAD is an ancestor of parent (already merged)
 */
export function isChildIntegrated(childBranchName: string, parentBranch: string): boolean {
    const repoRoot = process.env.CODE_METADATA_REPO_ROOT;
    if (!repoRoot || !childBranchName) return true; // No branch = integrated

    try {
        // Check if branch exists on remote
        const lsRemote = execSync(`git ls-remote --heads origin ${childBranchName}`, {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!lsRemote.trim()) {
            // Branch deleted = merged or rejected = integrated
            return true;
        }

        // Get child's HEAD commit
        const childHead = execSync(`git rev-parse origin/${childBranchName}`, {
            cwd: repoRoot,
            encoding: 'utf-8',
            timeout: 10000,
        }).trim();

        // Check if child HEAD is ancestor of parent branch
        execSync(`git merge-base --is-ancestor ${childHead} ${parentBranch}`, {
            cwd: repoRoot,
            stdio: 'ignore',
            timeout: 10000,
        });
        return true; // Exit 0 = is ancestor = integrated
    } catch {
        return false; // Exit non-zero OR error = not integrated
    }
}

/**
 * Batch fetch branches from remote for efficiency.
 * Call this before multiple isChildIntegrated checks.
 */
export function batchFetchBranches(branchNames: string[], parentBranch: string = 'main'): void {
    const repoRoot = process.env.CODE_METADATA_REPO_ROOT;
    if (!repoRoot || branchNames.length === 0) return;

    try {
        execSync(`git fetch origin ${parentBranch} ${branchNames.join(' ')} 2>/dev/null || true`, {
            cwd: repoRoot,
            stdio: 'ignore',
            timeout: 60000,
        });
    } catch (error) {
        // Some branches may not exist - that's fine
        workerLogger.debug({ error, branchCount: branchNames.length }, 'Some branches may not exist during batch fetch');
    }
}
