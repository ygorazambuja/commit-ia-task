/// <reference types="vite/client" />

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Elemento raiz da aplicação não encontrado");
}

createRoot(root).render(
	<StrictMode>
		<TooltipProvider>
			<App />
		</TooltipProvider>
	</StrictMode>,
);
