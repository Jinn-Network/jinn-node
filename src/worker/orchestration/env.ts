/**
 * Environment setup/teardown: CODE_METADATA_REPO_ROOT, .operate, etc.
 */

/**
 * Snapshot environment variables affected by jobs
 */
export function snapshotEnvironment(): {
  CODE_METADATA_REPO_ROOT?: string;
  JINN_BASE_BRANCH?: string;
} {
  return {
    CODE_METADATA_REPO_ROOT: process.env.CODE_METADATA_REPO_ROOT,
    JINN_BASE_BRANCH: process.env.JINN_BASE_BRANCH,
  };
}

/**
 * Restore environment variables from snapshot
 */
export function restoreEnvironment(snapshot: {
  CODE_METADATA_REPO_ROOT?: string;
  JINN_BASE_BRANCH?: string;
}): void {
  if (snapshot.CODE_METADATA_REPO_ROOT !== undefined) {
    process.env.CODE_METADATA_REPO_ROOT = snapshot.CODE_METADATA_REPO_ROOT;
  } else {
    delete process.env.CODE_METADATA_REPO_ROOT;
  }

  if (snapshot.JINN_BASE_BRANCH !== undefined) {
    process.env.JINN_BASE_BRANCH = snapshot.JINN_BASE_BRANCH;
  } else {
    delete process.env.JINN_BASE_BRANCH;
  }
}




