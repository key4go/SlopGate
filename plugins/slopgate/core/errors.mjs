export class SlopGateError extends Error {
  constructor(message, code = "SLOPGATE_ERROR") {
    super(message);
    this.name = "SlopGateError";
    this.code = code;
  }
}
