import { DsmlToolCallStripper, parseDsmlPayload } from './src/extension/byok/common/dsmlToolCallStripper.ts';

const payload = `｜｜DSML｜｜tool_calls>
｜｜DSML｜｜invoke name="run_in_terminal">`;
const s = new DsmlToolCallStripper();
console.log(s.process(payload));
console.log(s.flush());
