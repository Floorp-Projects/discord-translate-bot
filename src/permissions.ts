import type { GuildConfig } from "./types";

/**
 * Translate を実行してよいか判定する (docs/plan.md §4 権限モデル)。
 *
 * - ギルド設定が未設定 (KV に無い、または allowedRoleIds が空配列) → 全員許可
 * - 1 つでもロールが設定されていれば、実行者がそのいずれかを保持する場合のみ許可
 *
 * memberRoleIds は interaction.member.roles (ギルド外実行時は undefined)。
 */
export function isAllowedToTranslate(
	guildConfig: GuildConfig | null,
	memberRoleIds: readonly string[] | undefined,
): boolean {
	if (guildConfig === null || guildConfig.allowedRoleIds.length === 0) {
		return true;
	}
	if (memberRoleIds === undefined) {
		return false;
	}
	return guildConfig.allowedRoleIds.some((roleId) =>
		memberRoleIds.includes(roleId),
	);
}
