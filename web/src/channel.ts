/**
 * 채널톡 채팅 플러그인(우하단 챗봇).
 *
 * 플러그인 키는 서버가 /api/state 로 내려준 값을 쓴다. 빌드에 굽지 않으므로
 * 키를 바꿔도 웹을 다시 빌드할 필요가 없다.
 *
 * 로그인한 사용자는 memberId/memberHash 로 부팅해야 챗봇이 그 사람의 질문을
 * 식별할 수 있다. memberHash 는 서버가 계산한 값만 쓰고, 시크릿은 프런트에 없다.
 */
declare global {
  interface Window {
    ChannelIO?: ChannelIOApi;
    ChannelIOInitialized?: boolean;
  }
}

type ChannelIOApi = ((...args: unknown[]) => void) & {
  q?: unknown[];
  c?: (args: unknown) => void;
};

const SCRIPT_ID = "channel-io-sdk";
const SDK_URL = "https://cdn.channel.io/plugin/ch-plugin-web.js";

function loadSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.ChannelIOInitialized) return resolve();

    const queue: unknown[] = [];
    const shim: ChannelIOApi = function (...args: unknown[]) {
      if (window.ChannelIO?.c) {
        window.ChannelIO.c(args);
        return;
      }
      queue.push(args);
    };
    shim.q = queue;
    shim.c = (args: unknown) => queue.push(args);
    window.ChannelIO = shim;
    window.ChannelIOInitialized = true;

    if (document.getElementById(SCRIPT_ID)) return resolve();
    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = SDK_URL;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(Error("채널톡 플러그인을 불러오지 못했어요."));
    document.head.appendChild(script);
  });
}

export interface BootOptions {
  pluginKey: string;
  /** 기본 런처를 숨기고 서비스 색을 입힌 자체 버튼을 쓴다. */
  hideDefaultButton?: boolean;
  memberId?: string;
  memberHash?: string;
  profile?: Record<string, unknown>;
}

export type ChannelStatus =
  | "ready"
  | "anonymous" // 붙었지만 로그인 전이라 사용자를 특정하지 못함
  | "boot-rejected" // 채널톡이 부트를 거부함 (채널 설정 문제)
  | "load-failed"; // SDK 로드 실패 (광고 차단기/네트워크)

let booted = false;

export async function bootChannelTalk(
  options: BootOptions,
): Promise<ChannelStatus> {
  try {
    await loadSdk();
  } catch {
    return "load-failed";
  }

  const payload: Record<string, unknown> = { pluginKey: options.pluginKey };
  // 채널톡 런처 색은 채널 관리자 화면에서만 바꿀 수 있어서, 기본 버튼을 숨기고
  // 브랜드 색을 입힌 우리 버튼이 showMessenger 를 부르게 한다.
  if (options.hideDefaultButton) payload.hideChannelButtonOnBoot = true;
  if (options.memberId) payload.memberId = options.memberId;
  if (options.memberHash) payload.memberHash = options.memberHash;
  if (options.profile) payload.profile = options.profile;

  const settled: ChannelStatus = options.memberId ? "ready" : "anonymous";

  // 이미 부팅했다면 사용자만 갱신한다. boot 을 두 번 부르면 세션이 끊긴다.
  if (booted) {
    window.ChannelIO?.("updateUser", payload);
    return settled;
  }

  // boot 은 콜백으로 성공/실패를 알려준다. 결과를 안 보면 "떴다"고 착각한다.
  const status = await new Promise<ChannelStatus>((resolve) => {
    const timer = setTimeout(() => resolve("boot-rejected"), 8000);
    window.ChannelIO?.("boot", payload, (error: unknown) => {
      clearTimeout(timer);
      if (error) {
        console.warn("[channel-talk] boot 실패", error);
        resolve("boot-rejected");
        return;
      }
      resolve(settled);
    });
  });
  booted = status !== "boot-rejected";
  return status;
}

export function openChannelTalk(): void {
  window.ChannelIO?.("showMessenger");
}
