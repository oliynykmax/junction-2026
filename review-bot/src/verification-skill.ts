import instructions from "../../.agents/skills/verify-pr-change/SKILL.md" with { type: "text" };
import provision from "../../.agents/skills/verify-pr-change/scripts/provision-verifiers.sh" with { type: "text" };

export const VERIFICATION_SKILL = instructions;

function quote(value: string) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function installVerificationSkill(workspace: string) {
  const directory = `${workspace}/../verify-pr-change`;
  return {
    directory,
    command: [
      `mkdir -p ${quote(`${directory}/scripts`)}`,
      `printf '%s' ${quote(instructions)} > ${quote(`${directory}/SKILL.md`)}`,
      `printf '%s' ${quote(provision)} > ${quote(`${directory}/scripts/provision-verifiers.sh`)}`,
    ].join(" && "),
  };
}
