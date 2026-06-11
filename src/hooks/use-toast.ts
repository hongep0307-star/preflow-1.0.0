import * as React from "react";

import type { ToastActionElement, ToastPosition, ToastProps } from "@/components/ui/toast";

/* shadcn/ui 의 토스트 시스템에 다음 두 가지를 확장한다.
 *
 *  1. position: "top-center" | "bottom-right"
 *     Toaster 가 두 개의 ToastViewport 를 렌더하고, 각 토스트는 자신의
 *     position 값에 따라 라우팅된다. *기본값은 "top-center"* — 모든
 *     토스트가 Eagle 풍 컴팩트 바로 navbar 정중앙에 떠 통일된 시각 자리를
 *     가진다. "bottom-right" 는 escape hatch — 명시적으로 박은 토스트만
 *     그쪽으로 라우팅(현재 사용 없음, 추후 long-form 디버그용으로 예비).
 *
 *  2. 합리적인 상수
 *     기본 shadcn 템플릿이 들고 다니는 TOAST_LIMIT = 1 / TOAST_REMOVE_DELAY
 *     = 1_000_000 은 (a) 빠른 연속 동작 시 직전 Undo 가 곧바로 사라져
 *     사용자가 되돌릴 기회를 잃고 (b) dismiss 된 토스트가 16분간 state 에
 *     남아 누적되는 두 가지 부작용이 있다. 본 프로젝트의 사용 패턴에 맞춰
 *     LIMIT=3, REMOVE_DELAY=1000 으로 조정. 자동 닫힘은 Radix Toast.Root
 *     의 `duration` prop 으로 따로 제어 — 일반 토스트는 4-5s, Undo 바는
 *     6-7s 정도가 권장값이다(`toast(...)` 호출부에서 명시). */
const TOAST_LIMIT = 3;
const TOAST_REMOVE_DELAY = 1_000;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  /** 라우팅 대상 viewport. 미지정 시 "top-center" (기본 navbar-inline 바). */
  position?: ToastPosition;
};

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const;

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;

type Action =
  | {
      type: ActionType["ADD_TOAST"];
      toast: ToasterToast;
    }
  | {
      type: ActionType["UPDATE_TOAST"];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType["DISMISS_TOAST"];
      toastId?: ToasterToast["id"];
    }
  | {
      type: ActionType["REMOVE_TOAST"];
      toastId?: ToasterToast["id"];
    };

interface State {
  toasts: ToasterToast[];
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    });
  }, TOAST_REMOVE_DELAY);

  toastTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      };

    case "DISMISS_TOAST": {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t,
        ),
      };
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

type Toast = Omit<ToasterToast, "id">;

function toast({ ...props }: Toast) {
  const id = genId();

  /* update 는 *부분 갱신* — id 는 클로저에서 채워 넣고, 호출부는 변경할 필드만
   * 넘긴다(원본 shadcn 템플릿이 ToasterToast 전체를 요구하던 건 잉여 타입). */
  const update = (props: Partial<ToasterToast>) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    });
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id });

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss();
      },
    },
  });

  return {
    id: id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, [state]);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  };
}

export { useToast, toast };
