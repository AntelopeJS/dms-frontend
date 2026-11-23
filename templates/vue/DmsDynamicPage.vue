<script setup lang="ts">
import { type Component, computed } from "vue";
import { resolveDmsComponent, useDmsRoute } from "./frontend-module";

/** A value of the JSON the backend sends as a component's options. */
type ComponentOptionValue =
  | string
  | number
  | boolean
  | null
  | ComponentOptionValue[]
  | { [key: string]: ComponentOptionValue };

interface ComponentChild {
  id: string;
  component: ComponentDefinition;
  slot?: string;
  colSpan?: number;
}

interface ComponentDefinition {
  componentName?: string;
  options?: Record<string, ComponentOptionValue>;
  children?: ComponentChild[];
}

interface ResolvedComponentDefinition {
  id: string;
  component: Component | string;
  componentName?: string;
  options?: Record<string, ComponentOptionValue>;
  children: ResolvedComponentDefinition[];
  slot?: string;
  colSpan?: number;
}

interface PageLayout {
  components?: Record<string, ComponentDefinition>;
}

interface PageRoute {
  fullId?: string;
  fullSlug?: string;
}

interface PagePayload {
  layout?: PageLayout;
  route?: PageRoute;
}

interface DynamicPageProps {
  page: PagePayload;
}

const props = defineProps<DynamicPageProps>();
const route = useDmsRoute(props.page.route?.fullSlug);

function resolveDefinition(
  id: string,
  definition: ComponentDefinition,
  placement: Omit<ComponentChild, "id" | "component"> = {},
): ResolvedComponentDefinition {
  return {
    id,
    component: definition.componentName
      ? resolveDmsComponent(definition.componentName) || "div"
      : "div",
    componentName: definition.componentName,
    options: definition.options,
    children: (definition.children ?? []).map((child) => {
      const { id: childId, component, ...childPlacement } = child;
      return resolveDefinition(childId, component, childPlacement);
    }),
    ...placement,
  };
}

const components = computed(() =>
  Object.entries(props.page.layout?.components ?? {}).map(([id, definition]) =>
    resolveDefinition(id, definition),
  ),
);
</script>

<template>
  <div class="dms-page-stack space-y-6">
    <div v-for="component in components" :key="component.id">
      <DmsRecursiveComponent
        :component="component"
        :page-id="page.route?.fullId ?? ''"
        :component-id="component.id"
        :route-params="route.params"
      />
    </div>
  </div>
</template>
