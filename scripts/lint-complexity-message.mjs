const COMPLEXITY_RULE_ID = "complexity";
const COMPLEXITY_MESSAGE_PATTERN =
  /^(?<description>.+?) has a complexity of (?<complexity>\d+)\. Maximum allowed is \d+\.$/u;

export function parseComplexityMessage(file, message) {
  const match =
    message.ruleId === COMPLEXITY_RULE_ID ? COMPLEXITY_MESSAGE_PATTERN.exec(message.message) : null;

  if (!match) {
    throw new Error(`Could not parse complexity at ${file}:${message.line}:${message.column}`);
  }

  return {
    file,
    line: message.line,
    column: message.column,
    complexity: Number(match.groups.complexity),
    description: match.groups.description,
  };
}
