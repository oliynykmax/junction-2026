import instructions from "../../.agents/skills/verify-pr-change/SKILL.md" with { type: "text" };
import provision from "../../.agents/skills/verify-pr-change/scripts/provision-verifiers.sh" with { type: "text" };

export const VERIFICATION_SKILL = instructions;

export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function installVerificationSkill(workspace: string) {
  const directory = `${workspace}/../verify-pr-change`;
  return {
    directory,
    command: [
      `mkdir -p ${shellQuote(`${directory}/scripts`)}`,
      `printf '%s' ${shellQuote(instructions)} > ${shellQuote(`${directory}/SKILL.md`)}`,
      `printf '%s' ${shellQuote(provision)} > ${shellQuote(`${directory}/scripts/provision-verifiers.sh`)}`,
    ].join(" && "),
  };
}
