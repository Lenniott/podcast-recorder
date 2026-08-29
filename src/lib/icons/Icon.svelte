<script>
  // Shared chrome for every glyph: size follows font-size (1em) unless
  // a caller passes `size`. Stroke + currentColor matches Lucide/Heroicons
  // outline. If you pasted *filled* icons, switch fill to currentColor and
  // drop the stroke attrs instead of editing every file.
  let { size = undefined, children, ...rest } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  width={size ?? "1em"}
  height={size ?? "1em"}
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  {...rest}
>
  {@render children?.()}
</svg>
