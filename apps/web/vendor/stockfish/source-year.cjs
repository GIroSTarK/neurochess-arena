// The upstream build uses this method for its generated copyright header.
// Fix that build input without editing the corresponding engine source.
const NativeDate = Date;
global.Date = class extends NativeDate {
  getFullYear() {
    return 2026;
  }
};
