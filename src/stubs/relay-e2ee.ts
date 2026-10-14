// @getpaseo/relay@0.10.3 is published without its files. DocAi only talks to the local
// daemon, never the encrypted relay, so the relay transport is stubbed out.
const unsupported = () => {
  throw new Error("Paseo relay is not supported in DocAi");
};
export const createClientChannel = unsupported;
export const createDaemonChannel = unsupported;
export default {};
