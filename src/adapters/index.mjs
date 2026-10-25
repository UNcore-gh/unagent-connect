import {createAdapter as codex} from './codex.mjs'
import {createAdapter as claude} from './claude.mjs'
import {createAdapter as unagent} from './unagent.mjs'
import {createAdapter as workbuddy} from './workbuddy.mjs'
import {createAdapter as harness} from './harness.mjs'
/** Construction does not start a native process; only an opted-in run does. */
export function createAdapters(){return [unagent(),codex(),claude(),workbuddy(),harness()]}
