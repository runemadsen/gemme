# TODO list

## Serving collections

Now that collections have been built, I need the ability to serve all images in
a collection in a public manner, so the images can be used e.g. on a website,
etc. Here's what's needed:

- A collection can either be set to private (default) or public
- When set to public, all images in a collection can be reached on a URL
- TBD: image resizing happens on the fly and saves a resized version of the
  image
- TBD: Figure out how the resized images can have long cache control because
  they are immutable, without needing to have the version number in the URL's
