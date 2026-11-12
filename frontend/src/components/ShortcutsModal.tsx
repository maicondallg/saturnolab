import React from 'react';
import { Keyboard, X } from 'lucide-react';
import { useSaturnoStore } from '../store/useSaturnoStore';

export const ShortcutsModal: React.FC = () => {
  const { showShortcutsModal, setShowShortcutsModal } = useSaturnoStore();

  if (!showShortcutsModal) return null;

  const groups = [
    {
      title: 'IA Inline na Célula',
      items: [
        { desc: 'Abrir prompt de IA na célula ou seleção', keys: 'Ctrl + I  /  Ctrl + K' },
        { desc: 'Alternar entre Substituir e + No final', keys: 'Shift + Tab' },
        { desc: 'Aceitar código gerado', keys: 'Tab  /  Enter' },
        { desc: 'Aceitar código e executar célula', keys: 'Ctrl + Enter' },
        { desc: 'Cancelar / Fechar prompt', keys: 'Esc' },
      ],
    },
    {
      title: 'Execução e Edição Direta',
      items: [
        { desc: 'Executar célula e avançar', keys: 'Shift + Enter' },
        { desc: 'Executar célula atual', keys: 'Ctrl + Enter' },
        { desc: 'Executar e inserir nova abaixo', keys: 'Alt + Enter' },
        { desc: 'Mover célula para cima / baixo', keys: 'Alt + ↑ / ↓' },
        { desc: 'Alternar Código / Markdown', keys: 'Ctrl + M' },
        { desc: 'Excluir célula atual', keys: 'Ctrl + Shift + Backspace' },
        { desc: 'Sair para Command Mode', keys: 'Esc' },
        { desc: 'Salvar notebook (.ipynb)', keys: 'Ctrl + S' },
      ],
    },
    {
      title: 'Command Mode (após Esc)',
      items: [
        { desc: 'Entrar na célula para editar', keys: 'Enter' },
        { desc: 'Inserir célula acima / abaixo', keys: 'A  /  B' },
        { desc: 'Navegar entre células', keys: '↑ / ↓  ou  K / J' },
        { desc: 'Converter para Markdown / Código', keys: 'M  /  Y' },
        { desc: 'Excluir célula selecionada', keys: 'D, D' },
      ],
    },
  ];

  return (
    <div
      data-modal-root="true"
      onClick={() => setShowShortcutsModal(false)}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-[4px] shadow-2xl border overflow-hidden"
        style={{
          backgroundColor: 'var(--sat-bg-surface)',
          borderColor: 'var(--sat-border)',
          color: 'var(--sat-text-primary)',
        }}
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: 'var(--sat-border)' }}
        >
          <div className="flex items-center gap-2">
            <Keyboard size={15} style={{ color: 'var(--sat-text-secondary)' }} />
            <h3 className="font-semibold text-sm m-0">Atalhos de Teclado</h3>
          </div>
          <button
            onClick={() => setShowShortcutsModal(false)}
            className="p-1 rounded-[3px] hover:bg-black/5 dark:hover:bg-white/5 cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {groups.map((g) => (
            <div key={g.title} className="space-y-1.5">
              <h4
                className="text-[11px] font-semibold uppercase tracking-wider m-0"
                style={{ color: 'var(--sat-text-muted)' }}
              >
                {g.title}
              </h4>
              <div className="space-y-1">
                {g.items.map((it) => (
                  <div
                    key={it.desc}
                    className="flex items-center justify-between gap-3 py-1.5 px-2.5 rounded-[3px] text-xs"
                    style={{ backgroundColor: 'var(--sat-bg-subtle)' }}
                  >
                    <span>{it.desc}</span>
                    <kbd
                      className="font-mono text-[11px] px-1.5 py-0.5 rounded-[2px] border shrink-0"
                      style={{
                        backgroundColor: 'var(--sat-bg-surface)',
                        borderColor: 'var(--sat-border)',
                      }}
                    >
                      {it.keys}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
