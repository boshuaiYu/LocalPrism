import { create } from "zustand";
import {
  assignSkillFolders,
  emptySkillCategorySnapshot,
  loadSkillCategorySnapshot,
  saveSkillCategorySnapshot,
  upsertUserCategory,
  type SkillCategorySnapshot,
  type UserSkillCategory,
} from "@/lib/skill-categories";

interface SkillCategoryState extends SkillCategorySnapshot {
  selectedCategoryId: string;
  hydrate: () => void;
  setSelectedCategoryId: (id: string) => void;
  addCategory: (name: string) => UserSkillCategory | null;
  assignFolders: (folders: string[], categoryId: string) => void;
  resetForTests: () => void;
}

function persist(snapshot: SkillCategorySnapshot) {
  saveSkillCategorySnapshot(snapshot);
}

export const useSkillCategoryStore = create<SkillCategoryState>((set, get) => {
  const initial = loadSkillCategorySnapshot();
  return {
    ...initial,
    selectedCategoryId: initial.categories[0]?.id ?? "imported",

    hydrate: () => {
      const snapshot = loadSkillCategorySnapshot();
      set({
        ...snapshot,
        selectedCategoryId:
          get().selectedCategoryId &&
          snapshot.categories.some(
            (category) => category.id === get().selectedCategoryId,
          )
            ? get().selectedCategoryId
            : (snapshot.categories[0]?.id ?? "imported"),
      });
    },

    setSelectedCategoryId: (id) => {
      set({ selectedCategoryId: id });
    },

    addCategory: (name) => {
      const result = upsertUserCategory(
        { categories: get().categories, assignments: get().assignments },
        name,
      );
      if (!result) return null;
      persist(result.snapshot);
      set({
        ...result.snapshot,
        selectedCategoryId: result.category.id,
      });
      return result.category;
    },

    assignFolders: (folders, categoryId) => {
      const snapshot = assignSkillFolders(
        { categories: get().categories, assignments: get().assignments },
        folders,
        categoryId,
      );
      persist(snapshot);
      set(snapshot);
    },

    resetForTests: () => {
      const snapshot = emptySkillCategorySnapshot();
      persist(snapshot);
      set({
        ...snapshot,
        selectedCategoryId: snapshot.categories[0]?.id ?? "imported",
      });
    },
  };
});
