import { Interface } from 'ethers';
import {requireUser,logActivity,json} from './_auth.mjs';

const ADDRESS=/^0x[a-fA-F0-9]{40}$/;const MAX_LOOKBACK=2_000_000;const DEFAULT_LOOKBACK=500_000;const CHUNK=100_000;const MAX_EVENTS=120;
const approvalTopic='0x8c5be1e5ebec7d5bd14f714f28c88d37ba3a811b1a...';
