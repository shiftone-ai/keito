/** Shared projects (co-editing through a collaboration server) are under trial: on only in a build made with VITE_KEITO_COLLAB=1. */
export const SHARED_PROJECTS = import.meta.env.VITE_KEITO_COLLAB === '1';
