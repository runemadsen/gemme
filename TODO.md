# TODO list

## Collection visibility

Now that collections have been built, I need to introduce a visiblity setting
that can be set to either private (default) or public. The public visibility
setting allows anyone to load the latest version of the image via a URL.

Here's what I know:

- It should be possible to load resized versions of the image for use in the
  `srcset` and `sizes` image tag. This makes it possible to use the API directly
  to serve images for static websites and keep the image out of the target repo.
  The resize params should exist in the URL (such as the Cloudflare image resize
  URL's) so a CDN in front of this app can cache the assets for a long time.
- It should also be possible to transform images into other formats, such as
  making a `.webp` from a source `jgp` image. Also consider other
  transformations that are possible through `sharp`.
- The resized images should be saved to the `blobs` folder, so we don't resize
  the same image to the same size multiple times. The second time the image is
  requested, it should be served from `blobs`. This should be true even if the
  image is in multiple collections.
- We should consider how the thumbnail functionality fits into this. I would
  love if the thumbnail is simply just one of these resized images that are
  pre-generated, and that we later can pre-generate multiple versions of each
  image so it's ready to serve immediately. This could even be a setting in the
  config.
- The public setting for a collection applies to all files in the collection, or
  any child collections.

Here's what I'm not sure about:

- I just want to serve the latest image, not earlier versions. I also want to
  serve these images with immutable cache control headers, so they can be cached
  in a CDN in front of the app. But, what happens then when a new version of an
  image is created? Is that just up to the consumer to flush the cache in the
  CDN? The image will still be cached for a long time in the users browser.
