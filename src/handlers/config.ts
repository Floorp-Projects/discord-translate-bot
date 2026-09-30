import { setGuildConfig } from "../store";
import {
	buildEphemeralResponse,
	type Env,
	type Interaction,
	type InteractionResponse,
} from "../types";

/** Discord の PermissionFlagsBits.Administrator (1 << 3) */
const ADMINISTRATOR_PERMISSION = 8n;

/**
 * /translate-config roles:<role> のハンドラ。
 *
 * Discord の slash コマンドオプションはロールの複数選択に対応しないため、
 * type 9 (ROLE) の単一オプション roles を「許可ロールをこの 1 つに置き換える」
 * セマンティクスで実装する (README の注意書き参照)。
 * 実行するたびに既存の allowedRoleIds はこの 1 つで上書きされる。
 */
export async function handleConfig(
	env: Env,
	interaction: Interaction,
): Promise<InteractionResponse> {
	const guildId = interaction.guild_id;
	if (guildId === undefined) {
		return buildEphemeralResponse(
			"このコマンドはサーバー内でのみ使用できます。",
		);
	}

	// default_member_permissions ("8") の二重チェック。
	// ギルド interaction で member.permissions が欠損するのは想定外のため
	// 判定できない場合は拒否する (fail-closed)
	if (!hasAdministratorPermission(interaction.member)) {
		return buildEphemeralResponse(
			"このコマンドはサーバー管理者のみ実行できます。",
		);
	}

	const roleId = getRoleOption(interaction);
	if (roleId === null) {
		return buildEphemeralResponse("許可するロールが指定されていません。");
	}

	await setGuildConfig(env, guildId, [roleId]);
	return buildEphemeralResponse(
		`翻訳コマンドを使用できるロールを <@&${roleId}> に設定しました。\n(設定は実行のたびに上書きされます)`,
	);
}

/**
 * 実行者がサーバー管理者かを判定する。
 * permissions は 53 ビットを超えうるビットフィールド (10 進数文字列) のため BigInt で判定する。
 * ギルド interaction で permissions が欠損・パース不能な場合は権限を判定できないため
 * 拒否する (fail-closed)。正規の Discord interaction では欠損しないため実利用は壊れない。
 */
function hasAdministratorPermission(member: Interaction["member"]): boolean {
	const permissions = member?.permissions;
	if (permissions === undefined) {
		// permissions 欠損 → Discord 側 default_member_permissions のみでは
		// @everyone 開放時に無効化されるため、安全側で拒否する
		return false;
	}
	try {
		return (BigInt(permissions) & ADMINISTRATOR_PERMISSION) !== 0n;
	} catch {
		// 不正なビットフィールド文字列 → 判定不能のため拒否 (fail-closed)
		return false;
	}
}

/** options から roles (type 9: ROLE → ロール ID 文字列) を取り出す (無ければ null) */
function getRoleOption(interaction: Interaction): string | null {
	const option = interaction.data?.options?.find((opt) => opt.name === "roles");
	return typeof option?.value === "string" ? option.value : null;
}
