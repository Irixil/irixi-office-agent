import { useEffect } from 'react'
import { EditTool } from '@/components/office/types'
import type { EditorState } from '@/components/office/editor/editorState'

interface UseEditorKeyboardOptions {
  editMode: boolean
  editorRef: React.MutableRefObject<EditorState>
  onUndo: () => void
  onRedo: () => void
  onDeleteSelected: () => void
  onRotateSelected: () => void
  onExitEditMode: () => void
}

export function useEditorKeyboard({
  editMode,
  editorRef,
  onUndo,
  onRedo,
  onDeleteSelected,
  onRotateSelected,
  onExitEditMode,
}: UseEditorKeyboardOptions): void {
  useEffect(() => {
    if (!editMode) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey

      // Ctrl+Z — Undo
      if (isCtrl && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        onUndo()
        return
      }

      // Ctrl+Y or Ctrl+Shift+Z — Redo
      if ((isCtrl && e.key === 'y') || (isCtrl && e.key === 'z' && e.shiftKey)) {
        e.preventDefault()
        onRedo()
        return
      }

      // Delete/Backspace — Delete selected furniture
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (editorRef.current.selectedFurnitureUid) {
          e.preventDefault()
          onDeleteSelected()
        }
        return
      }

      // R — Rotate selected furniture
      if (e.key === 'r' || e.key === 'R') {
        if (editorRef.current.selectedFurnitureUid) {
          e.preventDefault()
          onRotateSelected()
        }
        return
      }

      // Escape — Deselect or exit edit mode
      if (e.key === 'Escape') {
        if (editorRef.current.selectedFurnitureUid) {
          editorRef.current.selectedFurnitureUid = null
        } else {
          onExitEditMode()
        }
        return
      }

      // Number keys 1-7: quick tool select
      const toolMap: Record<string, typeof EditTool[keyof typeof EditTool]> = {
        '1': EditTool.SELECT,
        '2': EditTool.TILE_PAINT,
        '3': EditTool.WALL_PAINT,
        '4': EditTool.ERASE,
        '5': EditTool.FURNITURE_PLACE,
        '6': EditTool.EYEDROPPER,
      }
      if (toolMap[e.key]) {
        editorRef.current.activeTool = toolMap[e.key]
        editorRef.current.selectedFurnitureUid = null
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editMode, editorRef, onUndo, onRedo, onDeleteSelected, onRotateSelected, onExitEditMode])
}
