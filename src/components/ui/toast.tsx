"use client";

import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import {
	CheckCircle2Icon,
	CircleAlertIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";

type ToastType = "success" | "warning" | "error";

const toastManager = ToastPrimitive.createToastManager();

function addToast(
	type: ToastType,
	title: string,
	description?: string,
): string {
	return toastManager.add({
		description,
		priority: type === "error" ? "high" : "low",
		timeout: type === "error" ? 7000 : 5000,
		title,
		type,
	});
}

const toast = {
	success: (title: string, description?: string) =>
		addToast("success", title, description),
	warning: (title: string, description?: string) =>
		addToast("warning", title, description),
	error: (title: string, description?: string) =>
		addToast("error", title, description),
};

function ToastIcon({ type }: { type?: string }) {
	if (type === "success") {
		return <CheckCircle2Icon aria-hidden="true" className="size-[18px]" />;
	}
	if (type === "warning") {
		return <TriangleAlertIcon aria-hidden="true" className="size-[18px]" />;
	}
	return <CircleAlertIcon aria-hidden="true" className="size-[18px]" />;
}

function ToastList() {
	const { toasts } = ToastPrimitive.useToastManager();

	return toasts.map((notification) => (
		<ToastPrimitive.Root
			className="app-toast"
			key={notification.id}
			swipeDirection={["right", "down"]}
			toast={notification}
		>
			<ToastPrimitive.Content className="app-toast-content">
				<span className="app-toast-icon">
					<ToastIcon type={notification.type} />
				</span>
				<div className="app-toast-copy">
					<ToastPrimitive.Title className="app-toast-title" />
					{notification.description ? (
						<ToastPrimitive.Description className="app-toast-description" />
					) : null}
				</div>
				<ToastPrimitive.Close
					aria-label="Fechar notificação"
					className="app-toast-close"
				>
					<XIcon aria-hidden="true" className="size-[15px]" />
				</ToastPrimitive.Close>
			</ToastPrimitive.Content>
		</ToastPrimitive.Root>
	));
}

function Toaster() {
	return (
		<ToastPrimitive.Provider limit={3} toastManager={toastManager}>
			<ToastPrimitive.Portal>
				<ToastPrimitive.Viewport
					aria-label="Notificações"
					className="app-toast-viewport"
				>
					<ToastList />
				</ToastPrimitive.Viewport>
			</ToastPrimitive.Portal>
		</ToastPrimitive.Provider>
	);
}

export { Toaster, toast };
