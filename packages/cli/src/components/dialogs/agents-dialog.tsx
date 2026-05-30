import { useCallback } from "react";
import { useDialog } from "../../providers/dialog";
import { DialogSearchList } from "../dialog-search-list";
import { MODES, getModeLabel, type ModeType } from "@nightcode/shared";

const AVAILABLE_MODES: ModeType[] = MODES;

type AgentsDialogContentProps = {
  currentMode: ModeType;
  onSelectMode: (mode: ModeType) => void;
};

export const AgentsDialogContent = ({ 
  currentMode, 
  onSelectMode 
}: AgentsDialogContentProps) => {
  const dialog = useDialog();

  const handleSelect = useCallback(
    (nextMode: ModeType) => {
      onSelectMode(nextMode);
      dialog.close();
    },
    [onSelectMode, dialog],
  );

  return (
    <DialogSearchList
      items={AVAILABLE_MODES}
      onSelect={handleSelect}
      filterFn={(item, query) => getModeLabel(item).toLowerCase().includes(query.toLowerCase())}
      renderItem={(item, isSelected) => (
        <text selectable={false} fg={isSelected ? "black" : "white"}>
          {item === currentMode ? " • " : "   "}
          {getModeLabel(item)}
        </text>
      )}
      getKey={(item) => item}
      placeholder="Search agents"
      emptyText="No matching agents"
    />
  );
};
